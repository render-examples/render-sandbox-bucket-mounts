import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import type { SandboxExecEvent } from "@renderinc/sdk/experimental";
import type { Bucket } from "../src/config.js";
import { demo, run, type Sandboxes } from "../src/example.js";
import { stopProcess } from "../src/sandbox/mount-buckets.mjs";

const sandbox: Awaited<ReturnType<Sandboxes["create"]>> = {
  id: "sandbox-test",
  status: "running",
  plan: "starter",
  networkPolicy: { default: "allow-all" },
  region: "oregon",
  timeoutSeconds: 900,
  createdAt: "2026-01-01T00:00:00Z",
};
const bucket: Bucket = {
  provider: "s3",
  name: "sample-private-s3",
  endpoint: "https://s3.us-west-2.amazonaws.com",
  region: "us-west-2",
  accessKeyId: "sample-aws-key",
  secretAccessKey: "sample-aws-secret",
  sessionToken: "sample-aws-session",
};

async function* events(...items: SandboxExecEvent[]): AsyncGenerator<SandboxExecEvent> {
  yield* items;
}

function client(t: TestContext) {
  t.mock.method(console, "log", () => {});
  return {
    create: t.mock.fn<Sandboxes["create"]>(async () => sandbox),
    get: t.mock.fn<Sandboxes["get"]>(async () => sandbox),
    terminate: t.mock.fn<Sandboxes["terminate"]>(async () => {}),
    exec: t.mock.fn<Sandboxes["exec"]>(async () =>
      events({ type: "exit", exit_code: 0 }),
    ),
    upload: t.mock.fn<Sandboxes["upload"]>(async () => {}),
  };
}

test("the runner uploads the standalone script and selected credentials, then terminates", async (t) => {
  const api = client(t);
  const command = "printf '%s' \"quotes, $(literal), and spaces\"";
  await demo(api, [bucket], { command });
  assert.deepEqual(api.create.mock.calls[0].arguments, [
    {
      timeoutSeconds: 900,
      networkPolicy: { default: "allow-all" },
    },
  ]);
  const uploads = api.upload.mock.calls;
  assert.equal(uploads.length, 2);
  assert.ok(uploads[0].arguments[1].endsWith("/mount-buckets.mjs"));
  assert.ok(Buffer.isBuffer(uploads[0].arguments[2]));
  const config = JSON.parse(String(uploads[1].arguments[2]));
  assert.deepEqual(config, { buckets: [bucket], writeDemo: false, command });
  for (const call of api.exec.mock.calls) {
    assert.ok(!call.arguments[1].includes(bucket.secretAccessKey));
    assert.ok(!call.arguments[1].includes(command));
  }
  assert.deepEqual(api.terminate.mock.calls[0].arguments, [sandbox.id]);
});

test("write access is enabled only when requested", async (t) => {
  const api = client(t);
  await demo(api, [bucket], { writeDemo: true });
  const config = JSON.parse(String(api.upload.mock.calls[1].arguments[2]));
  assert.equal(config.writeDemo, true);
});

for (const stage of [
  "readiness",
  "preflight",
  "installation",
  "upload",
  "workload",
] as const) {
  test(`a failure during ${stage} still terminates the sandbox`, async (t) => {
    const api = client(t);
    if (stage === "readiness") {
      api.create.mock.mockImplementation(async () => ({
        ...sandbox,
        status: "errored",
      }));
    } else if (stage === "upload") {
      api.upload.mock.mockImplementation(async () => {
        throw new Error("Upload failed");
      });
    } else {
      const failedCall = { preflight: 0, installation: 1, workload: 2 }[stage];
      api.exec.mock.mockImplementationOnce(
        async () => events({ type: "exit", exit_code: 7 }),
        failedCall,
      );
    }
    await assert.rejects(demo(api, [bucket]));
    assert.equal(api.terminate.mock.callCount(), 1);
    assert.equal(api.terminate.mock.calls[0].arguments[0], sandbox.id);
  });
}

test("a create failure does not attempt to terminate an unknown sandbox", async (t) => {
  const api = client(t);
  api.create.mock.mockImplementation(async () => {
    throw new Error("Create failed");
  });
  await assert.rejects(demo(api, [bucket]), /Create failed/);
  assert.equal(api.terminate.mock.callCount(), 0);
});

test("an abort before creation does not create a sandbox", async (t) => {
  const api = client(t);
  await assert.rejects(demo(api, [bucket], {}, AbortSignal.abort()));
  assert.equal(api.create.mock.callCount(), 0);
});

test("an abort during creation still terminates the returned sandbox", async (t) => {
  const api = client(t);
  const controller = new AbortController();
  api.create.mock.mockImplementation(async () => {
    controller.abort();
    return sandbox;
  });
  await assert.rejects(demo(api, [bucket], {}, controller.signal));
  assert.deepEqual(api.terminate.mock.calls[0].arguments, [sandbox.id]);
});

test("a command without a terminal status fails", async (t) => {
  const api = client(t);
  api.exec.mock.mockImplementation(async () => events());
  await assert.rejects(run(api, sandbox.id, "true"), /without an exit status/);
});

test("command output keeps stdout and stderr separate", async (t) => {
  const api = client(t);
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  api.exec.mock.mockImplementation(async () =>
    events(
      { type: "output", stream: "stdout", data: "result" },
      { type: "output", stream: "stderr", data: "warning" },
      { type: "exit", exit_code: 0 },
    ),
  );
  await run(api, sandbox.id, "true");
  assert.equal(stdout.mock.calls[0].arguments[0], "result");
  assert.equal(stderr.mock.calls[0].arguments[0], "warning");
});

test("cleanup stops and reaps a running child process", async (t) => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const completion = once(child, "exit").then(() => {});
  await once(child, "spawn");
  await stopProcess(child, completion);
  assert.equal(child.signalCode, "SIGTERM");
});
