# Live validation: October 17, 2026

The Python example passed these checks against real private Amazon S3 and
Cloudflare R2 buckets. The checks used the committed example without source
changes. The Python files now live in `python/`; their code has not changed.
The TypeScript example has automated checks but has not had a live bucket test.

| Check | Result |
| --- | --- |
| Guest FUSE support and `/dev/fuse` | Passed |
| Private S3 mount, read, and read-only write rejection | Passed |
| S3 and R2 mounted together, object reads, and read-only write rejection | Passed |
| S3 and R2 write, unmount, fresh mount, read, and delete | Passed |

Each read-only check read an object created through the provider's S3 API. An
attempt to write through each read-only mount failed with `EROFS`.

The write check used `example.py both --write-demo`. Run that command from the
`python/` directory in the current layout. It wrote a small text object
to each bucket and read its expected contents after a fresh `s3fs` mount. Both
providers returned:

```text
Verified s3: write, remount, read, delete.
Verified r2: write, remount, read, delete.
```

## Environment

- Render Sandboxes in Oregon, with the standard Debian Bookworm image.
- Render Python SDK 1.2.0, Linux guest kernel `6.18.51+`, and `s3fs` 1.90-1.
- S3 in `us-west-2`, with all four Block Public Access settings enabled, ACLs
  disabled, and SSE-S3 encryption configured.
- R2 in Western North America, with public access disabled and S3 API region
  `auto`.
- A temporary AWS role scoped to the test bucket, with 15-minute sessions.
- An R2 token scoped to the test bucket, with object read and write permission.

Both providers used temporary test buckets. No production bucket data was used.

## Cleanup

All four test sandboxes were terminated. The generated objects and both temporary
buckets were deleted. The AWS test role and its inline policy were deleted. The
R2 test token was deleted, and its local credentials file was removed. The R2
dashboard showed no remaining buckets or user API tokens after cleanup.

## Scope

These checks cover small text objects and private bucket authentication. They do
not measure throughput, concurrent writers, large multipart uploads, credential
refresh, or snapshot restore behavior.

Package installation emitted warnings about a legacy package-signing key and a
missing `/dev/pts` mount. Installation returned exit code zero, and the mount
checks passed.
