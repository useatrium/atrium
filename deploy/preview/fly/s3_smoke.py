#!/usr/bin/env python3
"""S3 compatibility smoke test for Atrium preview storage.

Atrium's current S3 client signs requests with us-east-1. This script lets the
preview helper verify that the configured bucket/endpoint works with that
signing behavior before creating Fly resources.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import sys
import urllib.error
import urllib.parse
import urllib.request


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret_key: str, date_stamp: str, region: str) -> bytes:
    k_date = sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k_region = sign(k_date, region)
    k_service = sign(k_region, "s3")
    return sign(k_service, "aws4_request")


def request(
    *,
    method: str,
    endpoint: str,
    bucket: str,
    key: str,
    access_key: str,
    secret_key: str,
    region: str,
    body: bytes = b"",
) -> tuple[int, bytes]:
    parsed = urllib.parse.urlparse(endpoint.rstrip("/"))
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("endpoint must be an absolute URL")

    now = dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_parts = [bucket] if key == "" else [bucket, *key.split("/")]
    canonical_uri = "/" + "/".join(urllib.parse.quote(part, safe="") for part in canonical_parts)
    canonical_headers = (
        f"host:{parsed.netloc}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        [method, canonical_uri, "", canonical_headers, signed_headers, payload_hash]
    )
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        signing_key(secret_key, date_stamp, region),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )

    req = urllib.request.Request(
        f"{parsed.scheme}://{parsed.netloc}{canonical_uri}",
        data=body if method in {"PUT", "POST"} else None,
        method=method,
    )
    req.add_header("Host", parsed.netloc)
    req.add_header("X-Amz-Date", amz_date)
    req.add_header("X-Amz-Content-Sha256", payload_hash)
    req.add_header("Authorization", authorization)
    if method == "PUT":
        req.add_header("Content-Type", "text/plain")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise RuntimeError(f"{method} failed: HTTP {exc.code}: {detail}") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--access-key", required=True)
    parser.add_argument("--secret-key", required=True)
    parser.add_argument("--signing-region", default="us-east-1")
    parser.add_argument("--prefix", default="previews/smoke")
    args = parser.parse_args()

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    key = f"{args.prefix.rstrip('/')}/{timestamp}-atrium-preview-smoke.txt"
    body = b"atrium preview s3 smoke test\n"

    print(f"bucket: {args.bucket}")
    print(f"endpoint: {urllib.parse.urlparse(args.endpoint).netloc}")
    print(f"signing region: {args.signing_region}")
    print(f"key: {key}")

    status, _ = request(
        method="HEAD",
        endpoint=args.endpoint,
        bucket=args.bucket,
        key="",
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.signing_region,
    )
    print(f"HEAD bucket: {status}")
    status, _ = request(
        method="PUT",
        endpoint=args.endpoint,
        bucket=args.bucket,
        key=key,
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.signing_region,
        body=body,
    )
    print(f"PUT: {status}")
    status, got = request(
        method="GET",
        endpoint=args.endpoint,
        bucket=args.bucket,
        key=key,
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.signing_region,
    )
    print(f"GET: {status}, bytes={len(got)}")
    if got != body:
        raise RuntimeError("GET body did not match PUT body")
    status, _ = request(
        method="DELETE",
        endpoint=args.endpoint,
        bucket=args.bucket,
        key=key,
        access_key=args.access_key,
        secret_key=args.secret_key,
        region=args.signing_region,
    )
    print(f"DELETE: {status}")
    print("s3 smoke: ok")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"s3 smoke: failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
