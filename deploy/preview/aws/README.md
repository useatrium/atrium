# Atrium AWS Preview Appliances

This is the AWS-only preview path: one disposable EC2 instance per preview,
running Surface with Docker Compose and Centaur with local k3s.

The goal is to match the current OVH production shape closely enough that live
agents, `node-sync`, and artifact rendering can be tested without mixing Fly and
AWS networking.

## Local Setup

Install dependencies:

```sh
python3 -m venv deploy/preview/aws/.venv
deploy/preview/aws/.venv/bin/pip install -r deploy/preview/aws/requirements.txt
```

Configure a temporary AWS profile:

```sh
aws configure --profile atrium-preview
AWS_PROFILE=atrium-preview aws sts get-caller-identity
```

The temporary key currently needs broad permissions for the spike. After the
first working deploy, replace it with a scoped policy.

## Create

```sh
deploy/preview/aws/.venv/bin/python deploy/preview/aws/previewctl.py create HEAD
```

Defaults:

- region: `us-east-1`
- instance: `t3a.xlarge`
- root EBS: `160` GB gp3
- TTL tag: 24 hours

The controller:

1. creates a control S3 bucket for source/bootstrap files;
2. creates a per-preview S3 bucket for Atrium files/apps;
3. creates a per-preview IAM user/access key scoped to that storage bucket;
4. creates/reuses an EC2 role, instance profile, key pair, and security group;
5. uploads a `git archive` of the requested commit;
6. launches Ubuntu 24.04 x86_64;
7. bootstraps Docker, k3s, Surface, Centaur, local registry, and Caddy.

## Launcher API

`launcher.py` is the narrow API that a production Atrium agent should call
instead of receiving AWS credentials. It owns the AWS profile on the launcher
host and exposes only create/status/destroy.

Run locally:

```sh
export PREVIEW_LAUNCHER_TOKEN="$(openssl rand -hex 32)"
export AWS_PROFILE=atrium-preview
deploy/preview/aws/.venv/bin/python deploy/preview/aws/launcher.py
```

Create a preview from a pushed branch or commit:

```sh
curl -fsS -X POST http://127.0.0.1:8787/previews \
  -H "authorization: Bearer $PREVIEW_LAUNCHER_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "repo": "useatrium/atrium",
    "ref": "feature/my-branch",
    "ttl_hours": 24,
    "requested_by": "@agent"
  }'
```

Check status:

```sh
curl -fsS http://127.0.0.1:8787/previews/prev-... \
  -H "authorization: Bearer $PREVIEW_LAUNCHER_TOKEN"
```

Destroy:

```sh
curl -fsS -X DELETE http://127.0.0.1:8787/previews/prev-... \
  -H "authorization: Bearer $PREVIEW_LAUNCHER_TOKEN"
```

Agent-facing contract:

- The agent must push the branch before requesting a preview.
- The launcher resolves the ref to an immutable commit SHA and deploys that SHA.
- The response includes `id`, `status`, `url`, `commit_sha`, and `expires_at`.
  `status` becomes `ready` once the preview URL answers `/healthz`.
- Previews are public HTTP URLs for now. Do not use production data or
  production secrets.
- TTL cleanup is best-effort in the launcher process. Run an external scheduled
  cleanup or keep the launcher running continuously before relying on it for
  cost control.

Example Atrium agent tool call shape:

```json
{
  "repo": "useatrium/atrium",
  "ref": "feature/foo",
  "ttl_hours": 24,
  "requested_by": "@allan"
}
```

## Status

```sh
deploy/preview/aws/.venv/bin/python deploy/preview/aws/previewctl.py status prev-...
```

Once the instance is running, SSH is:

```sh
ssh -i deploy/preview/aws/.state/atrium-preview-appliance.pem ubuntu@<public-host>
```

Useful remote logs:

```sh
sudo tail -f /var/log/atrium-preview-bootstrap.log
cat /var/lib/atrium-preview/status.json
cat /var/lib/atrium-preview/ready.json
```

## Destroy

```sh
deploy/preview/aws/.venv/bin/python deploy/preview/aws/previewctl.py destroy prev-... --wait
```

Destroy terminates the EC2 instance, deletes the per-preview storage bucket, and
deletes the per-preview S3 IAM user/access keys. The shared control bucket,
security group, instance profile, role, and EC2 key pair are retained for reuse.

## Known Limitations

- First boot builds Centaur images on the preview instance, so startup can be
  slow.
- AWS previews intentionally disable Centaur `toolServer` until preview
  repo-cache/tool delivery is configured. Basic Codex execution works without
  those extra `/app/tools` shims.
- The launcher is intentionally small: bearer-token auth, SQLite metadata, and
  local `previewctl.py` subprocesses. Put it behind TLS/auth infrastructure
  before exposing it beyond a trusted network.
- HTTP only for the first spike. Add Route53/ACM/Caddy TLS after the full stack
  works.
- The Surface S3 client currently requires explicit access key env vars, so the
  controller creates a per-preview IAM user instead of relying only on the EC2
  instance profile.
