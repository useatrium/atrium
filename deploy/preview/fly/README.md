# Atrium Fly Preview Environments

Disposable Fly.io preview environments for arbitrary Atrium branches.

The preview system is intentionally independent from the current production
deploy. Production runs through Cloudflare edge to an OVH Ubuntu box; previews
are branch/commit-scoped test environments created on demand.

## Goal

Given a pushed Atrium branch, create a public URL running that exact commit with:

- Atrium Surface.
- Live agents through Centaur.
- Isolated database and object storage.
- Generated preview-only secrets.
- A strict expiry time.
- A destroy path that is safe to run repeatedly.

The preview URL must be tied to an immutable commit SHA. Branch names are
metadata only.

## Current Decision Record

| Decision | V1 choice |
| --- | --- |
| Provider | Fly.io first. Revisit AWS/EC2 only if Centaur cannot run reliably on Fly. |
| Scope | Full Atrium with live agents. Surface-only is not sufficient for acceptance. |
| Data | Empty database by default. Snapshot/restore can be a manual operator/agent workflow later. |
| URL access | Public, obscure Fly URL. Do not use production data or credentials. |
| Image registry | Fly registry. Image tags are commit SHAs. |
| Launcher host | Fly-hosted launcher service. Local CLI can call the same API or perform spike operations directly. |
| Repo location | Keep this under `deploy/preview/fly/` for now; split out later if needed. |

## High-Level Architecture

```text
Atrium agent / GitHub Action / operator CLI
        |
        v
Preview launcher API
        |
        +--> resolve branch -> commit SHA
        +--> build/push image tagged by commit
        +--> create Fly preview app/machines
        +--> generate preview secrets
        +--> run migrations/seed
        +--> poll health
        +--> return URL + expiry
        |
        v
Fly preview app
        |
        +--> Surface server/web
        +--> Postgres
        +--> object storage config
        +--> Centaur/runtime support
```

The launcher owns Fly credentials. Production Atrium should not.

## Preview Lifecycle

1. User/agent pushes a branch.
2. User/agent asks for a preview.
3. Launcher resolves the branch to a commit SHA.
4. Launcher creates a Fly app named from the SHA plus a nonce.
5. Launcher builds and pushes images tagged with the commit SHA to that app's Fly registry repository.
6. Launcher provisions per-preview secrets and storage.
7. Launcher starts the preview.
8. Launcher waits for health checks.
9. Launcher returns the public URL and expiry.
10. Cleanup destroys expired previews and all scoped state.

The local spike CLI deploys from a temporary detached git worktree for the
requested ref. That keeps this preview machinery separate from the target
branch: an arbitrary existing branch can be deployed without already containing
these files.

## API Contract

The launcher should expose a small authenticated API:

```http
POST /previews
Authorization: Bearer <internal token>
Content-Type: application/json

{
  "repo": "useatrium/atrium",
  "branch": "feature/foo",
  "commit_sha": "abc123...",
  "ttl_hours": 24,
  "requested_by": "@allan",
  "tier": "full"
}
```

```json
{
  "id": "prev_abc123_a1b2",
  "status": "creating",
  "url": null,
  "expires_at": "2026-07-15T12:00:00Z"
}
```

```http
GET /previews/:id
DELETE /previews/:id
```

Statuses:

- `queued`
- `building`
- `creating`
- `migrating`
- `seeding`
- `ready`
- `failed`
- `destroying`
- `destroyed`
- `expired`

## Naming

Names must be deterministic enough to audit and short enough for Fly limits.

```text
preview id:  prev-<short-sha>-<nonce>
Fly app:     atrium-prev-<short-sha>-<nonce>
image tag:   <full-commit-sha>
S3 prefix:   previews/<preview-id>/
```

Never use raw branch names directly in infrastructure names.

## Data Model

The launcher needs a metadata store. SQLite is enough for the first launcher
deployment; Postgres is fine if we already need it for the launcher.

Suggested table shape:

```sql
create table previews (
  id text primary key,
  repo text not null,
  branch text,
  commit_sha text not null,
  fly_app_name text not null unique,
  url text,
  status text not null,
  tier text not null default 'full',
  requested_by text,
  image_tag text,
  db_ref text,
  object_storage_prefix text,
  created_at text not null,
  updated_at text not null,
  expires_at text not null,
  failure_message text
);
```

## State Isolation

### Database

V1 starts empty. Preferred preview isolation:

1. Separate Postgres Machine/volume per preview.
2. Separate database on shared preview-only Postgres.
3. Separate schema only if migrations are proven schema-safe.

For branch previews with arbitrary migrations, avoid shared schema.

Manual snapshot path for later:

1. Pick a running preview.
2. Stop writes or accept a point-in-time dump.
3. Run `pg_dump`.
4. Store dump in a preview seed bucket/prefix.
5. Future previews optionally restore that dump before migrations.

This does not need productized launcher functionality for the first spike.

### Object Storage

Use preview-scoped object storage:

- For branch previews as-is, inject Atrium's existing `S3_ENDPOINT`,
  `S3_BUCKET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` env vars.
- The current Atrium S3 client signs requests with `us-east-1`, so AWS S3
  buckets used by arbitrary existing branches should be in `us-east-1`.
- A shared preview bucket is acceptable for the first spike because the database
  is isolated per preview. Object-key prefix isolation needs app support before
  it can be guaranteed for arbitrary branches.
- Long-term preference: add explicit app support for an object prefix or use a
  launcher-managed bucket/prefix strategy once the target runtime supports it.

Never use production buckets or production credentials.

## Fly Deployment Shape

Start with a single-region preview.

### Shape A: Full Preview Appliance

One Fly app per preview, using one or more Machines:

- Surface server/web.
- Postgres.
- Object storage or Tigris/S3 config.
- Centaur/runtime support.

This is the fastest way to test product parity, but Centaur is the risk.

### Shape B: Fly-Native Split

One Fly app namespace per preview with multiple Machines/services managed by the
Fly Machines API.

This may fit Fly better if Centaur cannot run inside a single appliance.

## Centaur Spike Gate

V1 requires live agents, so the first real spike must answer:

Can Atrium + Centaur, including sandbox execution and node-sync/artifact capture,
run on Fly reliably enough under the preview cost target?

Known risk areas:

- Centaur currently relies on Kubernetes/Helm in the OVH box shape.
- Sandboxes and node-sync have host/overlay assumptions.
- Fly may not support the same privileged mount behavior.
- Warm pools should be disabled for cost.

Spike order:

1. Run Surface + DB + object storage.
2. Add Centaur with warm pool set to zero.
3. Start a no-op agent session.
4. Start an artifact-producing agent session.
5. Measure cost, startup time, and failure modes.

Fallbacks if full Centaur on Fly is not viable:

- Fly Surface preview + shared staging Centaur.
- Fly Surface preview + Fly Machines-based sandbox runtime.
- AWS/EC2 full appliance previews for stronger VM parity.

## Health Checks

A preview is `ready` only when:

- Surface `/healthz` returns 200.
- Migrations completed.
- Web URL loads.
- Object storage is reachable.
- Centaur health endpoint is OK.
- A minimal agent smoke either starts or runtime capacity is confirmed.

## Security Rules

- Launcher owns `FLY_API_TOKEN`.
- Do not put production infra credentials in the Atrium server.
- Generate per-preview secrets.
- Public previews must not use production data.
- Deletion must be scoped by preview id/app labels.
- Destroy must be idempotent.
- Logs should redact generated secrets and provider tokens.

## Cost Guardrails

- TTL required for every preview.
- Single region.
- Small shared CPU Machines.
- Warm pool disabled.
- Destroy volumes on expiry unless a snapshot was explicitly requested.
- Prefer object storage prefixes over per-preview MinIO once the spike works.

Target: under $1/hour per active preview.

## Local Operator Environment

Install:

```sh
brew install flyctl
flyctl auth login
```

Required env for local spike scripts:

```sh
export FLY_ORG=personal
export ATRIUM_PREVIEW_REGION=iad
export ATRIUM_PREVIEW_TTL_HOURS=24
export S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
export S3_BUCKET=atrium-preview-files-shared
export S3_ACCESS_KEY=...
export S3_SECRET_KEY=...
```

`deploy/preview/fly/.env` is gitignored and can hold the same values locally.
Run `deploy/preview/fly/previewctl.sh s3-smoke` before creating a preview; it
uses Atrium's current `us-east-1` S3 signing behavior.

Local commands:

```sh
deploy/preview/fly/previewctl.sh doctor
deploy/preview/fly/previewctl.sh s3-smoke
deploy/preview/fly/previewctl.sh plan origin/master
deploy/preview/fly/previewctl.sh create-surface origin/master
deploy/preview/fly/previewctl.sh destroy atrium-prev-...
```

## First Spike Checklist

- [ ] Create a Fly app with a generated name.
- [ ] Build one Surface image from a commit SHA and push to Fly registry.
- [ ] Provision Postgres for the preview.
- [ ] Generate and set preview secrets.
- [ ] Boot Surface and pass `/healthz`.
- [x] Decide object storage for spike: shared AWS S3 preview bucket injected through existing `S3_*` env vars.
- [ ] Use a `us-east-1` bucket or compatible endpoint so arbitrary current branches pass the S3 smoke check.
- [ ] Add Centaur with warm pool disabled.
- [ ] Start a no-op agent session.
- [ ] Start an artifact-producing agent session.
- [ ] Document measured startup time and cost.
- [ ] Add `previewctl destroy`.
- [ ] Add TTL cleanup.

## Files In This Directory

- `README.md` - architecture and spike plan.
- `env.example` - local/operator environment values.
- `previewctl.sh` - local operator CLI for naming, planning, S3 smoke checks, Surface preview creation, and destroy.
- `s3_smoke.py` - no-dependency S3 PUT/GET/DELETE compatibility check.
- `templates/` - config templates for image-based and source-build Fly preview spikes.
