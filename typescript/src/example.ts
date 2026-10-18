import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Render } from "@renderinc/sdk";
import { type Bucket, readBuckets, required } from "./config.js";

export type Sandboxes = Pick<
  Render["experimental"]["sandboxes"],
  "create" | "get" | "terminate" | "exec" | "upload"
>;
type Sandbox = Awaited<ReturnType<Sandboxes["create"]>>;
export interface Options {
  writeDemo?: boolean;
  command?: string;
}

const REMOTE_DIR = "/tmp/render-bucket-example";

export async function run(
  sandboxes: Sandboxes,
  sandboxId: string,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  let exitCode: number | undefined;
  const events = await sandboxes.exec(sandboxId, command, undefined, signal);
  for await (const event of events) {
    if (event.type === "output") {
      const stream = event.stream === "stderr" ? process.stderr : process.stdout;
      stream.write(event.data);
    } else {
      exitCode = event.exit_code;
    }
  }
  if (exitCode === undefined) {
    throw new Error("The command stream ended without an exit status.");
  }
  if (exitCode !== 0) {
    throw new Error(`The sandbox command failed with exit code ${exitCode}.`);
  }
}

async function waitUntilRunning(
  sandboxes: Sandboxes,
  initial: Sandbox,
  signal?: AbortSignal,
): Promise<void> {
  let sandbox = initial;
  const deadline = Date.now() + 180_000;
  while (sandbox.status !== "running") {
    signal?.throwIfAborted();
    if (sandbox.status !== "creating") {
      throw new Error(`The sandbox entered status ${sandbox.status}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error("The sandbox did not start within 180 seconds.");
    }
    await delay(3000, undefined, { signal });
    sandbox = await sandboxes.get(sandbox.id);
  }
}

export async function demo(
  sandboxes: Sandboxes,
  buckets: Bucket[],
  options: Options = {},
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const sandbox = await sandboxes.create({
    timeoutSeconds: 900,
    networkPolicy: { default: "allow-all" },
  });
  try {
    console.log(`Created ${sandbox.id}. Maximum lifetime: 15 minutes.`);
    signal?.throwIfAborted();
    await waitUntilRunning(sandboxes, sandbox, signal);
    await run(
      sandboxes,
      sandbox.id,
      "test -c /dev/fuse && grep -qw fuse /proc/filesystems || " +
        "{ echo 'This Sandbox guest needs FUSE support and /dev/fuse.' >&2; exit 1; }",
      signal,
    );
    await run(
      sandboxes,
      sandbox.id,
      "set -eu; apt-get update -qq; " +
        "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq " +
        "--no-install-recommends nodejs s3fs fuse ca-certificates util-linux; " +
        `install -d -m 700 ${REMOTE_DIR}`,
      signal,
    );
    const script = await readFile(
      new URL("./sandbox/mount-buckets.mjs", import.meta.url),
    );
    await sandboxes.upload(
      sandbox.id,
      `${REMOTE_DIR}/mount-buckets.mjs`,
      script,
      undefined,
      {
        signal,
      },
    );
    await sandboxes.upload(
      sandbox.id,
      `${REMOTE_DIR}/buckets.json`,
      JSON.stringify({
        buckets,
        writeDemo: options.writeDemo ?? false,
        command: options.command,
      }),
      undefined,
      { signal },
    );
    await run(sandboxes, sandbox.id, `node ${REMOTE_DIR}/mount-buckets.mjs`, signal);
  } finally {
    await sandboxes.terminate(sandbox.id);
    console.log(`Terminated ${sandbox.id}.`);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const { values, positionals } = parseArgs({
      options: {
        "write-demo": { type: "boolean", default: false },
        command: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(
        "Usage: npm run demo -- [s3|r2|both] [--write-demo] [--command COMMAND]",
      );
      return;
    }
    if (positionals.length > 1) {
      throw new Error("Choose one provider: s3, r2, or both.");
    }
    required(process.env, "RENDER_API_KEY");
    const ownerId = required(process.env, "RENDER_WORKSPACE_ID");
    const buckets = readBuckets(positionals[0] ?? "both", process.env);
    const render = new Render({ ownerId });
    await demo(
      render.experimental.sandboxes,
      buckets,
      { writeDemo: values["write-demo"], command: values.command },
      controller.signal,
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
