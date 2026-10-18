import assert from "node:assert/strict";
import test from "node:test";
import { readBuckets } from "../src/config.js";
import { mountCommand, workloadEnv } from "../src/sandbox/mount-buckets.mjs";

const env = {
  S3_BUCKET: "sample-private-s3",
  AWS_REGION: "us-west-2",
  AWS_ACCESS_KEY_ID: "sample-aws-key",
  AWS_SECRET_ACCESS_KEY: "sample-aws-secret",
  AWS_SESSION_TOKEN: "sample-aws-session",
  R2_BUCKET: "sample-private-r2",
  R2_ENDPOINT_URL: "https://example.r2.cloudflarestorage.com/",
  R2_ACCESS_KEY_ID: "sample-r2-key",
  R2_SECRET_ACCESS_KEY: "sample-r2-secret",
};

test("a selected provider does not require the other provider's settings", () => {
  const [bucket] = readBuckets("r2", {
    R2_BUCKET: env.R2_BUCKET,
    R2_ENDPOINT_URL: env.R2_ENDPOINT_URL,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  });
  assert.equal(bucket.provider, "r2");
  assert.equal(bucket.endpoint, "https://example.r2.cloudflarestorage.com");
  assert.equal(bucket.region, "auto");
});

test("each provider gets its own credentials and session token", () => {
  const [s3, r2] = readBuckets("both", env);
  assert.equal(s3.accessKeyId, env.AWS_ACCESS_KEY_ID);
  assert.equal(s3.secretAccessKey, env.AWS_SECRET_ACCESS_KEY);
  assert.equal(s3.sessionToken, env.AWS_SESSION_TOKEN);
  assert.equal(r2.accessKeyId, env.R2_ACCESS_KEY_ID);
  assert.equal(r2.secretAccessKey, env.R2_SECRET_ACCESS_KEY);
  assert.equal(r2.sessionToken, "");
  assert.equal(
    readBuckets("r2", { ...env, R2_SESSION_TOKEN: "sample-r2-session" })[0]
      .sessionToken,
    "sample-r2-session",
  );
});

test("missing settings and invalid provider names fail before a sandbox is created", () => {
  assert.throws(() => readBuckets("s3", {}), /Set AWS_REGION/);
  assert.throws(() => readBuckets("other", env), /Choose s3, r2, or both/);
  assert.throws(
    () => readBuckets("s3", { ...env, AWS_SECRET_ACCESS_KEY: " " }),
    /Set AWS_SECRET_ACCESS_KEY/,
  );
});

test("bucket names and endpoints cannot insert s3fs options", () => {
  assert.throws(() => readBuckets("s3", { ...env, S3_BUCKET: "bucket,allow_other" }));
  assert.throws(() =>
    readBuckets("s3", { ...env, AWS_REGION: "us-west-2,allow_other" }),
  );
  for (const endpoint of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/bucket",
    "https://example.com?option=value",
    "https://example.com#fragment",
    "https://example.com,allow_other",
    "invalid",
  ]) {
    assert.throws(
      () => readBuckets("r2", { ...env, R2_ENDPOINT_URL: endpoint }),
      /HTTPS origin/,
    );
  }
});

test("mount arguments omit credentials and use the selected access mode", () => {
  for (const bucket of readBuckets("both", env)) {
    const readOnly = mountCommand(bucket, `/mnt/${bucket.provider}`, true);
    assert.ok(readOnly.includes("ro"));
    assert.ok(!readOnly.includes("rw"));
    assert.ok(!readOnly.join(" ").includes(bucket.accessKeyId));
    assert.ok(!readOnly.join(" ").includes(bucket.secretAccessKey));
    if (bucket.sessionToken)
      assert.ok(!readOnly.join(" ").includes(bucket.sessionToken));
    assert.ok(mountCommand(bucket, `/mnt/${bucket.provider}`, false).includes("rw"));
  }
});

test("the workload does not inherit provider or Render credentials", () => {
  const clean = workloadEnv({
    ...env,
    RENDER_API_KEY: "sample-render-secret",
    RENDER_WORKSPACE_ID: "sample-workspace",
    PATH: "/usr/bin:/bin",
    HOME: "/root",
  });
  assert.deepEqual(clean, { PATH: "/usr/bin:/bin", HOME: "/root" });
});
