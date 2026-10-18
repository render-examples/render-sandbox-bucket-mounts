"""Mount buckets with s3fs and run a file workload inside the sandbox."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack, contextmanager
from itertools import islice
from pathlib import Path

try:
    from .config import Bucket
except ImportError:
    from config import Bucket


def workload_env() -> dict[str, str]:
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("AWS_", "S3_", "R2_", "RENDER_"))
    }


def mount_command(bucket: Bucket, path: Path, read_only: bool) -> list[str]:
    args = [
        "s3fs",
        bucket.name,
        str(path),
        "-f",
        "-o",
        f"url={bucket.endpoint}",
        "-o",
        f"endpoint={bucket.region}",
        "-o",
        "use_path_request_style",
        "-o",
        "listobjectsv2",
        "-o",
        "ro" if read_only else "rw",
        "-o",
        "nosuid,nodev",
    ]
    if bucket.provider == "r2":
        args.extend(["-o", "nomixupload"])
    if bucket.session_token:
        args.extend(["-o", "use_session_token"])
    return args


@contextmanager
def mount(bucket: Bucket, *, read_only: bool):
    path = Path("/mnt") / bucket.provider
    path.mkdir(parents=True, exist_ok=True)
    if os.path.ismount(path) or any(path.iterdir()):
        raise RuntimeError(f"The mount path {path} must be empty and unmounted.")
    env = workload_env()
    env.update(
        AWS_ACCESS_KEY_ID=bucket.access_key_id,
        AWS_SECRET_ACCESS_KEY=bucket.secret_access_key,
    )
    if bucket.session_token:
        env["AWS_SESSION_TOKEN"] = bucket.session_token
    with tempfile.TemporaryFile(mode="w+") as log:
        process = subprocess.Popen(
            mount_command(bucket, path, read_only),
            env=env,
            stdout=log,
            stderr=log,
        )
        try:
            deadline = time.monotonic() + 45
            while not os.path.ismount(path):
                if process.poll() is not None or time.monotonic() >= deadline:
                    log.seek(0)
                    details = log.read()[-4000:]
                    raise RuntimeError(f"Could not mount {bucket.provider}: {details}")
                time.sleep(0.1)
            print(f"Mounted {bucket.provider} at {path}.", flush=True)
            yield path
        finally:
            try:
                if os.path.ismount(path):
                    subprocess.run(["umount", str(path)], check=True, timeout=30)
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def verify_write(bucket: Bucket) -> None:
    name = f"render-sandbox-demo-{uuid.uuid4().hex}.txt"
    payload = f"Hello from a Render Sandbox using {bucket.provider}!\n"
    pending = False
    try:
        with mount(bucket, read_only=False) as path:
            with (path / name).open("x") as output:
                pending = True
                output.write(payload)
        with mount(bucket, read_only=False) as path:
            if (path / name).read_text() != payload:
                raise RuntimeError(
                    f"The {bucket.provider} file did not match after remount."
                )
            (path / name).unlink()
            pending = False
        print(f"Verified {bucket.provider}: write, remount, read, delete.", flush=True)
    finally:
        if pending:
            try:
                with mount(bucket, read_only=False) as path:
                    (path / name).unlink(missing_ok=True)
            except Exception:
                print(
                    f"Remove {name} from {bucket.name} if it still exists.",
                    file=sys.stderr,
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-demo", action="store_true")
    parser.add_argument("--command")
    args = parser.parse_args()
    config = Path(__file__).with_name("buckets.json")
    try:
        buckets = [Bucket(**item) for item in json.loads(config.read_text())]
    finally:
        config.unlink(missing_ok=True)
    if not shutil.which("s3fs") or not Path("/dev/fuse").is_char_device():
        raise RuntimeError("Install s3fs and use a Sandbox guest with /dev/fuse.")
    with ExitStack() as stack:
        for bucket in buckets:
            path = stack.enter_context(mount(bucket, read_only=not args.write_demo))
            print(f"First 10 entries in {path}:", flush=True)
            for entry in islice(path.iterdir(), 10):
                print(f"  {entry.name}", flush=True)
        if args.command is not None:
            subprocess.run(
                ["bash", "-lc", args.command], env=workload_env(), check=True
            )
    if args.write_demo:
        for bucket in buckets:
            verify_write(bucket)


if __name__ == "__main__":
    main()
