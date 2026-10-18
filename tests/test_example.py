import io
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from render.experimental.sandbox import SandboxExecExit, SandboxExecOutput

import example
from sandbox.config import read_buckets

S3_ENV = {
    "S3_BUCKET": "private-example",
    "AWS_REGION": "us-west-2",
    "AWS_ACCESS_KEY_ID": "example-access",
    "AWS_SECRET_ACCESS_KEY": "example-secret",
    "AWS_SESSION_TOKEN": "example-session",
}
R2_ENV = {
    "R2_BUCKET": "private-r2-example",
    "R2_ENDPOINT_URL": "https://example.eu.r2.cloudflarestorage.com/",
    "R2_ACCESS_KEY_ID": "r2-access",
    "R2_SECRET_ACCESS_KEY": "r2-secret",
}


class ConfigTests(unittest.TestCase):
    def test_s3_needs_no_r2_settings(self):
        buckets = read_buckets("s3", S3_ENV)
        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].session_token, "example-session")

    def test_missing_settings_do_not_expose_secrets(self):
        with self.assertRaisesRegex(ValueError, "R2_BUCKET") as error:
            read_buckets("both", S3_ENV)
        self.assertNotIn("example-secret", str(error.exception))

    def test_bucket_repr_excludes_credentials(self):
        bucket = read_buckets("s3", S3_ENV)[0]
        for value in (
            bucket.access_key_id,
            bucket.secret_access_key,
            bucket.session_token,
        ):
            self.assertNotIn(value, repr(bucket))

    def test_r2_uses_its_own_credentials_and_jurisdiction_endpoint(self):
        bucket = read_buckets("r2", S3_ENV | R2_ENV)[0]
        self.assertEqual(bucket.access_key_id, "r2-access")
        self.assertEqual(bucket.session_token, "")
        self.assertEqual(bucket.region, "auto")
        self.assertEqual(bucket.endpoint, R2_ENV["R2_ENDPOINT_URL"].rstrip("/"))

    def test_endpoint_rejects_plaintext_and_mount_option_injection(self):
        for endpoint in (
            "http://example.r2.cloudflarestorage.com",
            "https://example.r2.cloudflarestorage.com,use_path_request_style",
            "https://username:password@example.r2.cloudflarestorage.com",
            "https://example.r2.cloudflarestorage.com/bucket",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaisesRegex(ValueError, "HTTPS origin"):
                    read_buckets("r2", R2_ENV | {"R2_ENDPOINT_URL": endpoint})


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.sandboxes = MagicMock()
        self.sandboxes.create.return_value = SimpleNamespace(
            id="sbx-example", status="running"
        )
        self.sandboxes.exec.side_effect = lambda *args: iter(
            [SandboxExecExit(exit_code=0)]
        )

    def test_terminates_after_setup_failure(self):
        self.sandboxes.exec.side_effect = RuntimeError("setup failed")
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "setup failed"):
                example.demo(self.sandboxes, read_buckets("s3", S3_ENV))
        self.sandboxes.terminate.assert_called_once_with("sbx-example")

    def test_terminates_after_upload_failure(self):
        self.sandboxes.copy_to.side_effect = RuntimeError("upload failed")
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "upload failed"):
                example.demo(self.sandboxes, read_buckets("s3", S3_ENV))
        self.sandboxes.terminate.assert_called_once_with("sbx-example")

    def test_nonzero_exec_is_a_failure(self):
        self.sandboxes.exec.return_value = iter([SandboxExecExit(exit_code=7)])
        self.sandboxes.exec.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "exit code 7"):
            example.run(self.sandboxes, "sbx-example", "false")

    def test_output_without_exit_status_is_a_failure(self):
        self.sandboxes.exec.side_effect = None
        self.sandboxes.exec.return_value = iter(
            [SandboxExecOutput(stream="stdout", data="partial output")]
        )
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "without an exit status"):
                example.run(self.sandboxes, "sbx-example", "command")

    def test_success_keeps_render_key_out_of_sandbox_settings(self):
        copied_config = []

        def copy_to(_sandbox_id, source, _destination):
            if source.name == "buckets.json":
                copied_config.append(source.read_text())
                self.assertEqual(source.stat().st_mode & 0o777, 0o600)

        self.sandboxes.copy_to.side_effect = copy_to
        with (
            redirect_stdout(io.StringIO()),
            patch.dict("os.environ", {"RENDER_API_KEY": "keep-this-local"}),
        ):
            example.demo(
                self.sandboxes,
                read_buckets("s3", S3_ENV),
                command="printf '%s' 'test; echo safe'",
            )
        self.assertNotIn("keep-this-local", copied_config[0])
        self.assertNotIn("env", self.sandboxes.create.call_args.kwargs)
        self.sandboxes.terminate.assert_called_once_with("sbx-example")

    def test_terminates_when_sandbox_start_fails(self):
        self.sandboxes.create.return_value.status = "errored"
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "errored"):
                example.demo(self.sandboxes, read_buckets("s3", S3_ENV))
        self.sandboxes.exec.assert_not_called()
        self.sandboxes.terminate.assert_called_once_with("sbx-example")
