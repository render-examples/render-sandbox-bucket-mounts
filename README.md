# Private S3 and R2 mounts in Render Sandboxes

Use normal file operations to access private Amazon S3 and Cloudflare R2 buckets
from a [Render Sandbox](https://render.com/docs/sandboxes). Choose the Python or
TypeScript example. Each uses the official Render SDK to create a sandbox and
[s3fs-fuse](https://github.com/s3fs-fuse/s3fs-fuse) to mount buckets.

| Provider | Mount path | Authentication |
| --- | --- | --- |
| Amazon S3 | `/mnt/s3` | AWS access key, secret key, and optional session token |
| Cloudflare R2 | `/mnt/r2` | R2 S3 API access key, secret key, and optional session token |

Select one provider or mount both buckets in the same sandbox. The default run
mounts buckets as read-only, lists up to 10 entries from each bucket, unmounts
them, and terminates the sandbox. Both examples use the standard Sandbox image;
you do not need to build or publish a container image.

## Repository layout

| Path | Contents |
| --- | --- |
| [python/](python/) | Python runner, sandbox code, dependencies, and tests |
| [typescript/](typescript/) | TypeScript runner, sandbox code, dependencies, and tests |
| [.env.example](.env.example) | Shared environment variable template |
| [policies/](policies/) | S3 policies for read-only access and the write check |

Each language directory is a separate project. You need only its runtime and
package manager. Both use the same environment variables, mount paths, and flags.

## Requirements

- Python: Python 3.11 or later and [uv](https://docs.astral.sh/uv/getting-started/installation/).
- TypeScript: Node.js 22.9 or later and npm.
- A Render API key and a workspace with Sandboxes enabled.
- A private S3 bucket, a private R2 bucket, or both.
- A Sandbox guest kernel with FUSE support and `/dev/fuse`.

Each example installs its runtime, `s3fs`, and FUSE tools in the sandbox. It checks
kernel support first. The sandbox must be able to reach Debian package servers
and the selected storage endpoints. You do not need FUSE on your own computer.

Sandboxes is in early access. See the [Render guide](https://render.com/docs/sandboxes)
for access requirements and current limits. Both examples pin Render SDK 1.2.0.

## Run an example

```bash
git clone https://github.com/render-examples/render-sandbox-bucket-mounts.git
cd render-sandbox-bucket-mounts
```

Follow the [Python setup](python/README.md) or the
[TypeScript setup](typescript/README.md). Each guide shows how to copy the shared
environment template, install dependencies, and run the example.

Set `RENDER_API_KEY` and `RENDER_WORKSPACE_ID` in the language directory's `.env`,
then fill in the variables for each provider you want to use. The workspace ID
is on the workspace's Settings page in the Render Dashboard. Git ignores `.env`.
See the provider setup below for bucket permissions and credentials.

Choose `s3`, `r2`, or `both`. Use `--command` to run a Bash command while the
buckets are mounted. For example, an existing object at S3 key
`reports/latest.csv` is available at `/mnt/s3/reports/latest.csv`.

## Configure private S3 access

Keep **Block Public Access** enabled and ACLs disabled. Public bucket access and
browser CORS rules are not required. This example uses authenticated HTTPS
requests to the S3 regional endpoint. A bucket restricted to a separate VPC
endpoint needs a network path that this example does not configure.

Use a role that supplies temporary AWS credentials when possible. Set
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` together.
For long-term access keys, leave `AWS_SESSION_TOKEN` empty. Set `AWS_REGION` to
the bucket's region and `S3_BUCKET` to the bucket name, without `s3://`.

Attach [policies/s3-read-only.json](policies/s3-read-only.json) to the identity
that supplies these credentials. Replace `YOUR_BUCKET_NAME` with your bucket
name. The policy permits listing and reading that bucket only. For the optional
write check, use [policies/s3-demo-writes.json](policies/s3-demo-writes.json).
That policy permits writes and deletes only for keys that start with
`render-sandbox-demo-`.

Keep encryption at rest enabled. If objects use SSE-KMS, the identity and the
KMS key policy must also permit decryption. Writes with SSE-KMS need the relevant
data-key permission. See [S3 security guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html).
The S3 endpoint in this example targets standard AWS commercial regions.

## Configure private R2 access

1. Open **R2 object storage** in the Cloudflare dashboard.
2. Select **Manage API Tokens** and create an R2 token.
3. Select **Object Read only** and scope it to the chosen bucket. Select
   **Object Read & Write** if you will run the write check.
4. Copy the **Access Key ID** and **Secret Access Key** to the `R2_*` variables.
   Use the S3 API key pair, rather than the Cloudflare API token value.
5. Set `R2_BUCKET` to the bucket name. Set `R2_ENDPOINT_URL` to the S3 API origin
   shown for that bucket, without the bucket name in the URL.

The usual endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
Jurisdictional buckets use their matching endpoint, such as
`https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`. The example signs R2 requests
with region `auto`, uses path-style requests, and disables mixed multipart copy
uploads with `nomixupload`.

Keep the bucket private. Do not enable `r2.dev` or add a public custom domain.
See [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/),
[S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), and the
[s3fs provider guide](https://github.com/s3fs-fuse/s3fs-fuse/wiki/Non-Amazon-S3).

## Check writes across a remount

Use dedicated sample buckets and credentials with write and delete permission.

From the selected language directory:

| Language | Command |
| --- | --- |
| Python | `uv run --env-file .env python example.py both --write-demo` |
| TypeScript | `npm run demo -- both --write-demo` |

This mode mounts the selected buckets with write access. For each bucket, it
creates a small object named `render-sandbox-demo-<random-id>.txt`, closes the
file, and unmounts the bucket. It then starts a fresh mount, reads the object,
checks its contents, and deletes it. This check does not rely on the first
mount's cache. If you also supply `--command`, that command has write access
within the permissions of your bucket credentials.

The example removes its test objects after success and tries to remove them
after a failure. If the process or sandbox stops abruptly, a test object can
remain. Remove keys with the `render-sandbox-demo-` prefix when you no longer
need them. In a versioned S3 bucket, older object versions and delete markers
can remain after deletion.

## How the examples work

1. [python/example.py](python/example.py) or
   [typescript/src/example.ts](typescript/src/example.ts) validates the selected
   settings and creates a sandbox with a 15-minute maximum lifetime.
2. It waits for `running`, checks FUSE, and installs the mount tools.
3. It copies the mount code and a credentials file into a directory that only
   root can access. The Render API key stays on your computer.
4. The [Python mount code](python/sandbox/mount_buckets.py) or the compiled
   [TypeScript mount code](typescript/src/sandbox/mount-buckets.mts) reads and
   removes the credentials file. It starts one foreground `s3fs` process per
   bucket, with separate AWS-compatible credentials in each process's environment.
5. It runs the file workload, unmounts the buckets, and stops the mount processes.
6. The local runner calls `terminate` in `finally`, including after setup,
   upload, or workload errors and normal interrupts.

If the local process stops before cleanup, the sandbox's lifetime limits how
long it can run. To terminate it manually, use the printed sandbox ID in the
Dashboard or use the SDK's `sandboxes.terminate` method with `RENDER_API_KEY` and
`RENDER_WORKSPACE_ID` set.

## Limits and operational notes

- Bucket credentials are available inside the sandbox. Removing the credentials
  file and filtering the workload's environment do not prevent a process with
  root access from reading mount-process credentials. Run trusted workloads in
  this example and use credentials scoped to the data they may access. A
  read-only mount also needs read-only IAM or R2 permissions to limit API access.
- The runner enables outbound network access for package installation and
  storage requests. For a production workload, use an outbound allow-list that
  includes the required package and storage hosts.
- A bucket mount has object-storage semantics. Renames are not atomic, multiple
  writers do not share file locks, and directory operations can require many
  requests. Use it for artifacts and file processing. Use a local filesystem for
  databases and workloads that require full POSIX semantics. See the
  [s3fs limitations](https://github.com/s3fs-fuse/s3fs-fuse#limitations).
- Temporary credentials must remain valid for the complete run. This sample
  does not refresh them. Unmount before you capture or restore a Sandbox snapshot;
  a snapshot does not preserve an external bucket connection.
- Sandbox compute, bucket storage, requests, and applicable data-transfer fees
  can incur charges. Mounting and listing can generate several storage API
  requests. See [Render pricing](https://render.com/pricing),
  [S3 pricing](https://aws.amazon.com/s3/pricing/), and
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- For production S3 use, enable access logging, CloudTrail data events, and
  CloudWatch metrics as needed. Encrypt log destinations and account for their
  charges. See [S3 monitoring](https://docs.aws.amazon.com/AmazonS3/latest/userguide/monitoring-overview.html).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Sandboxes are unavailable | Confirm that the workspace has Sandbox access and that `RENDER_WORKSPACE_ID` is correct. |
| FUSE check fails | Use a Sandbox guest kernel with FUSE enabled and `/dev/fuse`. Installing `s3fs` alone cannot add kernel support. |
| S3 returns 403 | Check the bucket region, identity policy, bucket policy, session-token expiry, and any KMS key policy. An explicit deny can override an allow. |
| R2 rejects authentication | Use the R2 S3 key pair, the bucket's exact S3 API endpoint, and a token scoped to that bucket. |
| A write fails | Set `--write-demo` and grant write permission. The supplied S3 write policy permits only the sample's object prefix. |
| A mount times out | Check endpoint reachability, bucket permissions, and credential validity. The mount waits up to 45 seconds before it fails. |

For S3 permission failures, see the [AWS 403 guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-403-errors.html).

## Validate the code

Each language guide lists its format, lint, and test commands. CI runs both
projects in separate jobs.

These checks need no cloud credentials. They cover provider configuration,
credential separation, failed mount processes, command exit handling, and
sandbox cleanup. Use a private test bucket to check your credentials and network
access.
