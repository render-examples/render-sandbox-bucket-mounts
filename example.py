"""Create a Render sandbox and mount the selected private buckets."""

import argparse
import json
import os
import shlex
import signal
import sys
import tempfile
import time
from dataclasses import asdict
from pathlib import Path

from render import Render
from render.experimental.sandbox import SandboxExecExit, SandboxExecOutput

from sandbox.config import read_buckets, required

REMOTE_DIR = "/tmp/render-bucket-example"
SANDBOX_LIFETIME_SECONDS = 900


def run(sandboxes, sandbox_id: str, command: str) -> None:
    exit_code = None
    for event in sandboxes.exec(sandbox_id, command):
        if isinstance(event, SandboxExecOutput):
            stream = sys.stderr if event.stream == "stderr" else sys.stdout
            print(event.data, end="", file=stream, flush=True)
        elif isinstance(event, SandboxExecExit):
            exit_code = event.exit_code
    if exit_code is None:
        raise RuntimeError("The command stream ended without an exit status.")
    if exit_code != 0:
        raise RuntimeError(f"The sandbox command failed with exit code {exit_code}.")


def wait_until_running(sandboxes, sandbox) -> None:
    deadline = time.monotonic() + 180
    while sandbox.status != "running":
        if sandbox.status != "creating":
            raise RuntimeError(f"The sandbox entered status {sandbox.status}.")
        if time.monotonic() >= deadline:
            raise TimeoutError("The sandbox did not start within 180 seconds.")
        time.sleep(3)
        sandbox = sandboxes.from_id(sandbox.id)


def demo(sandboxes, buckets, *, write_demo=False, command=None) -> None:
    sandbox = sandboxes.create(
        timeout_seconds=SANDBOX_LIFETIME_SECONDS,
        network_policy="allow-all",
    )
    try:
        print(f"Created {sandbox.id}. Maximum lifetime: 15 minutes.", flush=True)
        wait_until_running(sandboxes, sandbox)
        run(
            sandboxes,
            sandbox.id,
            "test -c /dev/fuse && grep -qw fuse /proc/filesystems || "
            "{ echo 'This Sandbox guest needs FUSE support and /dev/fuse.' >&2; "
            "exit 1; }",
        )
        run(
            sandboxes,
            sandbox.id,
            "set -eu; apt-get update -qq; "
            "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "
            "--no-install-recommends python3 s3fs fuse ca-certificates util-linux; "
            f"install -d -m 700 {REMOTE_DIR}",
        )
        source = Path(__file__).resolve().parent / "sandbox"
        for name in ("config.py", "mount_buckets.py"):
            sandboxes.copy_to(sandbox.id, source / name, f"{REMOTE_DIR}/{name}")
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "buckets.json"
            config.touch(mode=0o600)
            config.write_text(json.dumps([asdict(bucket) for bucket in buckets]))
            sandboxes.copy_to(sandbox.id, config, f"{REMOTE_DIR}/buckets.json")
        args = ["python3", "-u", f"{REMOTE_DIR}/mount_buckets.py"]
        if write_demo:
            args.append("--write-demo")
        if command is not None:
            args.extend(["--command", command])
        run(sandboxes, sandbox.id, shlex.join(args))
    finally:
        sandboxes.terminate(sandbox.id)
        print(f"Terminated {sandbox.id}.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "provider", choices=("s3", "r2", "both"), default="both", nargs="?"
    )
    parser.add_argument(
        "--write-demo", action="store_true", help="Check writes across a remount."
    )
    parser.add_argument(
        "--command", help="Run this Bash command while buckets are mounted."
    )
    args = parser.parse_args()
    try:
        required(os.environ, "RENDER_API_KEY")
        owner_id = required(os.environ, "RENDER_WORKSPACE_ID")
        buckets = read_buckets(args.provider, os.environ)
        render = Render(owner_id=owner_id)
        demo(
            render.experimental.sandboxes,
            buckets,
            write_demo=args.write_demo,
            command=args.command,
        )
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None


def on_terminate(_signum, _frame) -> None:
    raise SystemExit(143)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, on_terminate)
    main()
