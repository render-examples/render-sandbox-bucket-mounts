import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from sandbox.config import Bucket
from sandbox.mount_buckets import mount, mount_command, verify_write, workload_env


def bucket(provider="s3", session_token=""):
    return Bucket(
        provider=provider,
        name="private-example",
        endpoint="https://example.com",
        region="auto" if provider == "r2" else "us-west-2",
        access_key_id="example-access",
        secret_access_key="example-secret",
        session_token=session_token,
    )


class MountTests(unittest.TestCase):
    def test_readonly_mount_and_r2_compatibility(self):
        args = mount_command(bucket("r2"), Path("/mnt/r2"), True)
        self.assertIn("ro", args)
        self.assertNotIn("rw", args)
        self.assertIn("nomixupload", args)
        self.assertIn("endpoint=auto", args)
        self.assertIn("use_path_request_style", args)
        self.assertNotIn("example-secret", " ".join(args))

    def test_temporary_credentials_require_a_session_token(self):
        args = mount_command(bucket(session_token="token"), Path("/mnt/s3"), True)
        self.assertIn("use_session_token", args)

    def test_workload_does_not_inherit_credentials(self):
        with patch.dict(
            "os.environ",
            {
                "AWS_SESSION_TOKEN": "secret",
                "R2_SECRET_ACCESS_KEY": "secret",
                "PATH": "/bin",
            },
            clear=True,
        ):
            self.assertEqual(workload_env(), {"PATH": "/bin"})

    def test_mount_failure_reaps_the_process(self):
        process = MagicMock()
        process.poll.return_value = 1
        with (
            patch("sandbox.mount_buckets.Path.mkdir"),
            patch("sandbox.mount_buckets.Path.iterdir", return_value=iter([])),
            patch("sandbox.mount_buckets.os.path.ismount", return_value=False),
            patch("sandbox.mount_buckets.subprocess.Popen", return_value=process),
        ):
            with self.assertRaisesRegex(RuntimeError, "Could not mount s3"):
                with mount(bucket(), read_only=True):
                    self.fail("A failed mount must not run the workload.")
        process.wait.assert_called_once()

    def test_write_failure_does_not_remove_an_existing_object(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "render-sandbox-demo-fixed.txt").write_text("existing data")
            context = MagicMock()
            context.__enter__.return_value = path
            with (
                patch(
                    "sandbox.mount_buckets.uuid.uuid4",
                    return_value=MagicMock(hex="fixed"),
                ),
                patch("sandbox.mount_buckets.mount", return_value=context),
            ):
                with self.assertRaises(FileExistsError):
                    verify_write(bucket())
            self.assertEqual(
                (path / "render-sandbox-demo-fixed.txt").read_text(), "existing data"
            )
