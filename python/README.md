# Python example

Create a Render Sandbox and mount a private S3 bucket, a private R2 bucket, or
both. This project uses the [Render Python SDK](https://render.com/docs/sandboxes-sdk-python).
See the [shared guide](../README.md) for bucket permissions, FUSE requirements,
and operational limits.

## Setup

Use Python 3.11 or later and [uv](https://docs.astral.sh/uv/getting-started/installation/).
From the repository root:

```bash
cd python
cp ../.env.example .env
uv sync --locked
```

Edit `.env`. Set `RENDER_API_KEY`, `RENDER_WORKSPACE_ID`, and the selected
provider's settings. Follow the [S3 setup](../README.md#configure-private-s3-access)
or [R2 setup](../README.md#configure-private-r2-access). Git ignores `.env`.

## Run

```bash
# Mount both buckets as read-only and list up to 10 entries from each.
uv run --env-file .env python example.py both

# Mount one bucket with only that provider's settings.
uv run --env-file .env python example.py s3
uv run --env-file .env python example.py r2

# Run a command while both buckets are mounted.
uv run --env-file .env python example.py both \
  --command 'find /mnt/s3 /mnt/r2 -maxdepth 1 -type f'

# Write an object, remount, read it, and delete it from each bucket.
uv run --env-file .env python example.py both --write-demo
```

The write check needs write and delete permission. See the
[write check guide](../README.md#check-writes-across-a-remount) before you use it.
Each run terminates its sandbox in `finally` and sets a 15-minute maximum lifetime.

## Files

- [example.py](example.py): local SDK runner and command-line interface.
- [sandbox/config.py](sandbox/config.py): provider settings and validation.
- [sandbox/mount_buckets.py](sandbox/mount_buckets.py): mount processes and file workload.
- [tests/](tests/): checks that need no cloud credentials.

## Validate

```bash
uv run ruff check .
uv run ruff format --check .
uv run python -m unittest discover -s tests -v
```
