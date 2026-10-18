# TypeScript example

Create a Render Sandbox and mount a private S3 bucket, a private R2 bucket, or
both. This project uses the [Render TypeScript SDK](https://render.com/docs/sandboxes-sdk-typescript).
See the [shared guide](../README.md) for bucket permissions, FUSE requirements,
and operational limits.

## Setup

Use Node.js 22.9 or later and npm. From the repository root:

```bash
cd typescript
cp ../.env.example .env
npm ci
```

Edit `.env`. Set `RENDER_API_KEY`, `RENDER_WORKSPACE_ID`, and the selected
provider's settings. Follow the [S3 setup](../README.md#configure-private-s3-access)
or [R2 setup](../README.md#configure-private-r2-access). Git ignores `.env`.

## Run

```bash
# Mount both buckets as read-only and list up to 10 entries from each.
npm run demo -- both

# Mount one bucket with only that provider's settings.
npm run demo -- s3
npm run demo -- r2

# Run a command while both buckets are mounted.
npm run demo -- both \
  --command 'find /mnt/s3 /mnt/r2 -maxdepth 1 -type f'

# Write an object, remount, read it, and delete it from each bucket.
npm run demo -- both --write-demo
```

`npm run demo` compiles TypeScript, loads the local `.env` if it exists, and
starts the runner. You can also set the variables in your shell.

The write check needs write and delete permission. See the
[write check guide](../README.md#check-writes-across-a-remount) before you use it.
Each run terminates its sandbox in `finally` and sets a 15-minute maximum lifetime.

## Files

- [src/example.ts](src/example.ts): local SDK runner and command-line interface.
- [src/config.ts](src/config.ts): provider settings and validation.
- [src/sandbox/mount-buckets.mts](src/sandbox/mount-buckets.mts): mount processes
  and file workload. It compiles to a standalone `.mjs` file that uses only Node
  built-in modules. The runner installs Node.js in the sandbox and uploads this
  file; the sandbox does not need npm packages.
- [test/](test/): checks that need no cloud credentials.

## Validate

```bash
npm run check
npm test
```

The checks cover types, format, lint, provider settings, credential separation,
process cleanup, and sandbox cleanup after failures. The TypeScript implementation
has not had a live bucket test. The [live validation record](../docs/live-validation.md)
covers the Python implementation.
