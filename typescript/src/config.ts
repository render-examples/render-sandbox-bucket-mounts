export type Provider = "s3" | "r2";

export interface Bucket {
  provider: Provider;
  name: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim()) {
    throw new Error(`Set ${key} in .env or in your environment.`);
  }
  return value;
}

export function readBuckets(provider: string, env: NodeJS.ProcessEnv): Bucket[] {
  if (provider !== "s3" && provider !== "r2" && provider !== "both") {
    throw new Error("Choose s3, r2, or both.");
  }
  const providers: Provider[] = provider === "both" ? ["s3", "r2"] : [provider];
  return providers.map((selected) => {
    let bucket: Bucket;
    if (selected === "s3") {
      const region = required(env, "AWS_REGION");
      if (!/^[a-z0-9-]+$/.test(region)) {
        throw new Error("AWS_REGION must be an AWS region name.");
      }
      bucket = {
        provider: "s3",
        name: required(env, "S3_BUCKET"),
        endpoint: `https://s3.${region}.amazonaws.com`,
        region,
        accessKeyId: required(env, "AWS_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "AWS_SECRET_ACCESS_KEY"),
        sessionToken: env.AWS_SESSION_TOKEN ?? "",
      };
    } else {
      bucket = {
        provider: "r2",
        name: required(env, "R2_BUCKET"),
        endpoint: required(env, "R2_ENDPOINT_URL").replace(/\/+$/, ""),
        region: "auto",
        accessKeyId: required(env, "R2_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
        sessionToken: env.R2_SESSION_TOKEN ?? "",
      };
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.name)) {
      throw new Error(`${selected.toUpperCase()}_BUCKET must be a bucket name.`);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(bucket.endpoint);
    } catch {
      throw new Error(`The ${selected} endpoint must be an HTTPS origin.`);
    }
    if (
      endpoint.protocol !== "https:" ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      bucket.endpoint.includes(",")
    ) {
      throw new Error(`The ${selected} endpoint must be an HTTPS origin.`);
    }
    return bucket;
  });
}
