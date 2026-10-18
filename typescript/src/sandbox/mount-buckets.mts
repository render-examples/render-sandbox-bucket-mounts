import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Bucket } from "../config.js";

const execute = promisify(execFile);

interface Mount {
  path: string;
  close(): Promise<void>;
}

export function workloadEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(AWS_|S3_|R2_|RENDER_)/.test(key)),
  );
}

export function mountCommand(
  bucket: Bucket,
  path: string,
  readOnly: boolean,
): string[] {
  const args = [
    bucket.name,
    path,
    "-f",
    "-o",
    `url=${bucket.endpoint}`,
    "-o",
    `endpoint=${bucket.region}`,
    "-o",
    "use_path_request_style",
    "-o",
    "listobjectsv2",
    "-o",
    readOnly ? "ro" : "rw",
    "-o",
    "nosuid,nodev",
  ];
  if (bucket.provider === "r2") args.push("-o", "nomixupload");
  if (bucket.sessionToken) args.push("-o", "use_session_token");
  return args;
}

async function isMounted(path: string): Promise<boolean> {
  try {
    await execute("mountpoint", ["-q", path], { timeout: 5000 });
    return true;
  } catch (error) {
    if ((error as { code?: number | string }).code === 32) return false;
    throw error;
  }
}

export async function stopProcess(
  child: ChildProcess,
  completion: Promise<void>,
): Promise<void> {
  const stopped = () =>
    child.exitCode !== null || child.signalCode !== null || !child.pid;
  if (!stopped()) child.kill("SIGTERM");
  await Promise.race([completion, delay(10_000, undefined, { ref: false })]);
  if (!stopped()) {
    child.kill("SIGKILL");
    await Promise.race([completion, delay(5000, undefined, { ref: false })]);
    if (!stopped()) throw new Error("The mount process did not stop.");
  }
}

async function mount(bucket: Bucket, readOnly: boolean): Promise<Mount> {
  const path = `/mnt/${bucket.provider}`;
  await mkdir(path, { recursive: true });
  if ((await isMounted(path)) || (await readdir(path)).length) {
    throw new Error(`The mount path ${path} must be empty and unmounted.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "render-bucket-mount-"));
  const logPath = join(directory, "s3fs.log");
  const log = await open(logPath, "w", 0o600);
  const env = {
    ...workloadEnv(),
    AWS_ACCESS_KEY_ID: bucket.accessKeyId,
    AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
    ...(bucket.sessionToken ? { AWS_SESSION_TOKEN: bucket.sessionToken } : {}),
  };
  const child = spawn("s3fs", mountCommand(bucket, path, readOnly), {
    env,
    stdio: ["ignore", log.fd, log.fd],
  });
  let stopped = false;
  let spawnError: Error | undefined;
  const completion = new Promise<void>((done) => {
    child.once("error", (error) => {
      spawnError = error;
      stopped = true;
      done();
    });
    child.once("exit", () => {
      stopped = true;
      done();
    });
  });
  const close = async () => {
    try {
      if (await isMounted(path)) await execute("umount", [path], { timeout: 30_000 });
    } finally {
      try {
        await stopProcess(child, completion);
      } finally {
        await log.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const deadline = Date.now() + 45_000;
    while (!(await isMounted(path))) {
      if (spawnError) throw spawnError;
      if (stopped || Date.now() >= deadline) {
        const details = (await readFile(logPath, "utf8")).slice(-4000);
        throw new Error(`Could not mount ${bucket.provider}: ${details}`);
      }
      await delay(100);
    }
    console.log(`Mounted ${bucket.provider} at ${path}.`);
    return { path, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function withMount<T>(
  bucket: Bucket,
  readOnly: boolean,
  workload: (path: string) => Promise<T>,
): Promise<T> {
  const mounted = await mount(bucket, readOnly);
  try {
    return await workload(mounted.path);
  } finally {
    await mounted.close();
  }
}

async function verifyWrite(bucket: Bucket): Promise<void> {
  const name = `render-sandbox-demo-${randomUUID().replaceAll("-", "")}.txt`;
  const payload = `Hello from a Render Sandbox using ${bucket.provider}!\n`;
  let pending = false;
  try {
    await withMount(bucket, false, async (path) => {
      const output = await open(join(path, name), "wx");
      pending = true;
      try {
        await output.writeFile(payload);
      } finally {
        await output.close();
      }
    });
    await withMount(bucket, false, async (path) => {
      if ((await readFile(join(path, name), "utf8")) !== payload) {
        throw new Error(`The ${bucket.provider} file did not match after remount.`);
      }
      await unlink(join(path, name));
      pending = false;
    });
    console.log(`Verified ${bucket.provider}: write, remount, read, delete.`);
  } finally {
    if (pending) {
      try {
        await withMount(bucket, false, (path) => rm(join(path, name), { force: true }));
      } catch {
        console.error(`Remove ${name} from ${bucket.name} if it still exists.`);
      }
    }
  }
}

async function runWorkload(command: string): Promise<void> {
  const child = spawn("bash", ["-lc", command], {
    env: workloadEnv(),
    stdio: "inherit",
  });
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else
        fail(new Error(`The workload failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

async function main(): Promise<void> {
  const configPath = new URL("./buckets.json", import.meta.url);
  let config: { buckets: Bucket[]; writeDemo: boolean; command?: string };
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } finally {
    await rm(configPath, { force: true });
  }
  if (!(await stat("/dev/fuse")).isCharacterDevice()) {
    throw new Error("Use a Sandbox guest with /dev/fuse.");
  }
  const mounts: Mount[] = [];
  const errors: unknown[] = [];
  try {
    for (const bucket of config.buckets) {
      const mounted = await mount(bucket, !config.writeDemo);
      mounts.push(mounted);
      console.log(`First 10 entries in ${mounted.path}:`);
      let count = 0;
      for await (const entry of await opendir(mounted.path)) {
        console.log(`  ${entry.name}`);
        if (++count === 10) break;
      }
    }
    if (config.command !== undefined) await runWorkload(config.command);
  } catch (error) {
    errors.push(error);
  } finally {
    const results = await Promise.allSettled(
      mounts.reverse().map((item) => item.close()),
    );
    errors.push(
      ...results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    );
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      errors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("\n"),
    );
  }
  if (config.writeDemo) {
    for (const bucket of config.buckets) await verifyWrite(bucket);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
