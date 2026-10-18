"""Read the settings for the selected buckets."""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Bucket:
    provider: str
    name: str
    endpoint: str
    region: str
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)
    session_token: str = field(default="", repr=False)


def required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "")
    if not value.strip():
        raise ValueError(f"Set {key} in .env or in your environment.")
    return value


def read_buckets(provider: str, env: Mapping[str, str]) -> list[Bucket]:
    if provider not in {"s3", "r2", "both"}:
        raise ValueError("Choose s3, r2, or both.")
    buckets = []
    for selected in ("s3", "r2") if provider == "both" else (provider,):
        if selected == "s3":
            region = required(env, "AWS_REGION")
            if not re.fullmatch(r"[a-z0-9-]+", region):
                raise ValueError("AWS_REGION must be an AWS region name.")
            bucket = Bucket(
                provider="s3",
                name=required(env, "S3_BUCKET"),
                endpoint=f"https://s3.{region}.amazonaws.com",
                region=region,
                access_key_id=required(env, "AWS_ACCESS_KEY_ID"),
                secret_access_key=required(env, "AWS_SECRET_ACCESS_KEY"),
                session_token=env.get("AWS_SESSION_TOKEN", ""),
            )
        else:
            bucket = Bucket(
                provider="r2",
                name=required(env, "R2_BUCKET"),
                endpoint=required(env, "R2_ENDPOINT_URL").rstrip("/"),
                region="auto",
                access_key_id=required(env, "R2_ACCESS_KEY_ID"),
                secret_access_key=required(env, "R2_SECRET_ACCESS_KEY"),
                session_token=env.get("R2_SESSION_TOKEN", ""),
            )
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket.name):
            raise ValueError(f"{selected.upper()}_BUCKET must be a bucket name.")
        endpoint = urlsplit(bucket.endpoint)
        if (
            endpoint.scheme != "https"
            or not endpoint.hostname
            or endpoint.username
            or endpoint.password
            or endpoint.path
            or endpoint.query
            or endpoint.fragment
            or "," in bucket.endpoint
        ):
            raise ValueError(f"The {selected} endpoint must be an HTTPS origin.")
        buckets.append(bucket)
    return buckets
