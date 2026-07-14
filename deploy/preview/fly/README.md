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
        +--> preview iron-control for provider credential grants
```

The launcher owns Fly credentials. Production Atrium should not.

`iron-control` is part of the preview control plane, not just an optional
setting. Surface can boot without it, but provider credential storage, GitHub
connections, and live-agent credential grants return
`iron_control_unconfigured`. For the spike, use one shared preview
`iron-control` Fly app with a separate Postgres database. Each Surface preview
uses a distinct `IRON_CONTROL_NAMESPACE`, so the control plane is shared while
preview records remain logically scoped.

Longer term, a per-preview `iron-control` app is cleaner isolation because it
puts encrypted credentials, API keys, and grants inside the same TTL boundary as
the preview. It also adds another Fly app, another Postgres instance, more
startup time, and more cost to every preview. The shared preview control plane
is the pragmatic first step.

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

### What the OVH deploy actually runs

The production OVH script is not just wiring Surface to one HTTP sidecar. It
deploys two different runtime layers:

- Surface runs with Docker Compose.
- Centaur runs in single-node k3s through the Helm chart.

The Centaur deploy builds and deploys these images together:

- `centaur-api-rs`
- `centaur-iron-proxy`
- `centaur-agent` / sandbox
- `centaur-node-sync`
- `centaur-console`

It then renders the Helm chart with:

- `centaur/contrib/chart/values.dev.yaml`
- `infra/values.local.yaml`
- `deploy/values.box.yaml`

Before doing the long image build/rollout path, the production script templates
the Helm chart and checks every referenced Kubernetes secret/key exists. Keep
that preflight behavior for any preview Centaur automation; missing keys such as
`ARTIFACT_CAPTURE_API_KEY` or `CENTAUR_JWT_SIGNING_SECRET` otherwise show up late
as `CreateContainerConfigError`.

### Why api-rs alone is not enough

Centaur's `local` sandbox backend is for development and manager validation. The
real `codex-app-server` workload refuses to run unless
`SESSION_SANDBOX_BACKEND=agent-k8s`. That means a Fly preview cannot get real
`@agent` behavior by starting `api-rs` in local mode.

For live agents, the preview must provide one of:

1. A Kubernetes-backed Centaur runtime, using `agent-k8s`.
2. A shared preview/staging Centaur runtime running somewhere Kubernetes works,
   with each Fly Surface preview wired to a distinct namespace/config scope.
3. A deliberately reduced mock/local Centaur mode for UI plumbing only. This is
   not acceptance for live agents.

### Surface-to-Centaur wiring

Once a Centaur API is running, Surface needs:

- `CENTAUR_BASE_URL`
- `CENTAUR_API_KEY`

On OVH, the API is exposed with a k3s NodePort and Surface receives the
`LOCAL_DEV_API_KEY` value from the `centaur-infra-env` Kubernetes secret. For Fly
previews, the equivalent should be injected as Fly secrets into each Surface
preview. Current `create-surface` intentionally leaves these empty until a real
preview Centaur endpoint exists.

### Required Centaur secrets/config

The Helm chart expects a Kubernetes secret named `centaur-infra-env` by default.
Preview automation must create or top up at least:

- `DATABASE_URL`
- `LOCAL_DEV_API_KEY`
- `CENTAUR_JWT_SIGNING_SECRET`
- `ARTIFACT_CAPTURE_API_KEY`
- iron-control keys when `console.enabled=true`

The preview must also create the chart-required firewall CA secrets, or reuse
the existing bootstrap helper that creates them.

Provider auth has two possible V1 modes:

- Production-like: `console.enabled=true`, `apiRs.ironProxy.mode=enabled`,
  `apiRs.ironProxy.perUserSubscription=true`, and sandbox auth modes
  `access_token`. Users connect their own Codex/Claude credentials through
  iron-control.
- Simpler preview-only: set sandbox auth to API-key mode and inject
  preview-scoped provider API keys. This is easier to automate but less like
  production and must not use production keys.

### Repo overlays and arbitrary branches

`deploy/values.box.yaml` points the repo-cache overlay at `useatrium/atrium` with
`ref: master`. That is wrong for arbitrary branch previews if the agent skill,
tool, or workflow changes are part of the branch being tested.

Preview Centaur must either:

- set the overlay source ref to the target commit SHA, or
- build an image from the target commit that already contains the desired tools,
  workflows, and `.agents/skills`.

The preview URL should still be tied to an immutable commit SHA, not a mutable
branch name.

### Node-sync and artifact capture

Artifact capture requires more than an agent response. The `node-sync`
DaemonSet must be enabled, and Centaur must be able to reach Surface at
`nodeSync.atriumBaseUrl` with the same `ARTIFACT_CAPTURE_API_KEY` that Surface
has.

On OVH this address is a topology-specific internal host IP
(`http://10.42.0.1:3001`). For Fly previews the simplest shared-runtime path is
to point node-sync at the public Fly Surface URL over HTTPS and use the preview's
capture API key. A per-preview Centaur appliance could use private networking
instead, but that depends on the final Fly/k8s shape.

Current limitation: `node-sync` reads `ATRIUM_BASE_URL` and
`ATRIUM_CAPTURE_API_KEY` from pod env. In the shared-runtime shape, artifact
capture is therefore attached to one active Surface preview at a time. Multiple
simultaneous Surface previews can share the same Centaur for basic API traffic
only if artifact capture is disabled or accepted as pointing at the currently
configured Surface. Full multi-preview artifact capture requires per-preview
Centaur, per-tenant node-sync, or dynamic capture routing.

### Iron-control alignment

Surface and Centaur must use the same iron-control service. If Surface saves a
provider credential grant into the shared preview `iron-control` Fly app while
api-rs/iron-proxy points at an in-cluster Centaur console, agents will still fail
authentication because the credential state is split.

The shared preview Centaur spike in `deploy/preview/centaur/` disables the
in-cluster console and passes the shared preview `IRON_CONTROL_BASE_URL` /
`IRON_CONTROL_API_KEY` into api-rs.

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

Recommended next implementation step:

1. Stand up a shared preview Centaur runtime on a VM/k3s environment, because it
   matches the OVH deploy most closely and avoids proving nested k3s on Fly
   before we can test product behavior.
2. Wire one existing Fly Surface preview to that runtime with `CENTAUR_BASE_URL`
   and `CENTAUR_API_KEY`.
3. Run the no-op `@agent` smoke.
4. Run an artifact-producing session and verify node-sync capture renders the
   generated app inside Atrium.
5. Only after that works, decide whether per-preview Centaur belongs on Fly,
   Fly Machines, or AWS/EC2.

Implementation starter:

- `deploy/preview/centaur/deploy-shared-runtime.sh`
- `deploy/preview/centaur/values.shared-preview.yaml`
- `deploy/preview/centaur/README.md`

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

Provider credential storage, GitHub connections, and live-agent credential
grants require a reachable iron-control service. When these values are present
in `.env`, `create-surface` injects them as Fly secrets:

```sh
export IRON_CONTROL_BASE_URL=https://<iron-control-host>
export IRON_CONTROL_API_KEY=iak_...
export IRON_CONTROL_NAMESPACE=default
```

Without those values, the Surface preview can serve the UI and API, but flows
that save provider credentials return `iron_control_unconfigured`.

Create or verify the shared preview `iron-control`:

```sh
deploy/preview/fly/previewctl.sh create-iron-control
```

This command creates:

- Fly app `atrium-preview-iron-control` by default.
- Fly Postgres app `atrium-preview-iron-control-pg` by default.
- Rails encryption and bootstrap secrets.
- A bootstrap API key for Surface to call `/api/v1`.

It appends the resulting `IRON_CONTROL_BASE_URL`, `IRON_CONTROL_API_KEY`, and
default namespace values to the local gitignored `.env`. Existing values are not
printed.

Do not rotate the generated Rails encryption keys or initial API key for an
existing preview `iron-control` database unless you intend to invalidate stored
credentials. The helper keeps existing bootstrap secrets in place on reruns. If
the Fly app already has an API key but the local `.env` lost
`IRON_CONTROL_API_KEY`, recreate the shared control-plane app or restore the
local secret from your password manager.

Wire an already-running Surface preview to the shared control plane:

```sh
deploy/preview/fly/previewctl.sh wire-surface-iron-control atrium-prev-...
```

The default namespace is derived from the Surface preview app name. You can pass
an explicit namespace as the second argument.

Local commands:

```sh
deploy/preview/fly/previewctl.sh doctor
deploy/preview/fly/previewctl.sh s3-smoke
deploy/preview/fly/previewctl.sh create-iron-control
deploy/preview/fly/previewctl.sh plan origin/master
deploy/preview/fly/previewctl.sh create-surface origin/master
deploy/preview/fly/previewctl.sh wire-surface-iron-control atrium-prev-...
deploy/preview/fly/previewctl.sh destroy atrium-prev-...
```

## First Spike Checklist

- [x] Create a Fly app with a generated name.
- [x] Build one Surface image from a commit SHA and push to Fly registry.
- [x] Provision Postgres for the preview.
- [x] Generate and set preview secrets.
- [x] Boot Surface and pass `/healthz`.
- [x] Create shared preview `iron-control` and pass `/up`.
- [x] Wire Surface previews to `iron-control` with per-preview namespaces.
- [x] Decide object storage for spike: shared AWS S3 preview bucket injected through existing `S3_*` env vars.
- [x] Use a `us-east-1` bucket or compatible endpoint so arbitrary current branches pass the S3 smoke check.
- [ ] Choose shared preview Centaur vs per-preview Centaur appliance for the next spike.
- [x] Add shared preview Centaur runtime script/values for a k3s VM.
- [ ] Provision a Centaur k3s runtime or prove Fly can host the required `agent-k8s` shape.
- [ ] Build/publish Centaur images for `api-rs`, `iron-proxy`, `sandbox`, `node-sync`, and `console`.
- [ ] Bootstrap `centaur-infra-env` and chart-required CA/firewall secrets.
- [ ] Run Helm secret preflight before deploy.
- [ ] Deploy Centaur with warm pool disabled.
- [ ] Inject `CENTAUR_BASE_URL` and `CENTAUR_API_KEY` into a Surface preview.
- [x] Validate against an existing local kind Centaur that `agent-k8s` + `codex-app-server` can start a sandbox and complete a `PONG` turn.
- [ ] Start a no-op agent session.
- [ ] Start an artifact-producing agent session.
- [ ] Verify node-sync artifact capture from Centaur to Surface.
- [ ] Verify the captured app renders inside the Atrium thread and full app view.
- [ ] Document measured startup time and cost.
- [ ] Add `previewctl destroy`.
- [ ] Add TTL cleanup.

## Files In This Directory

- `README.md` - architecture and spike plan.
- `env.example` - local/operator environment values.
- `previewctl.sh` - local operator CLI for naming, planning, S3 smoke checks, Surface preview creation, and destroy.
- `s3_smoke.py` - no-dependency S3 PUT/GET/DELETE compatibility check.
- `templates/` - config templates for image-based and source-build Fly preview spikes.
