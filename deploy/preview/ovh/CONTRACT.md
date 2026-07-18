# Atrium Preview Environments — OVH backend CONTRACT (V1)

This is the shared contract for the OVH warm-box preview system. It ports the AWS
launcher (`deploy/preview/aws/`) to a single dedicated OVH box using
**k3d-cluster-per-preview** (POC-validated). Every component below must conform to
this contract. Do not diverge without updating this file.

## Why k3d-per-preview (locked, stress-tested)
- Namespace-per-preview is IMPOSSIBLE: the agent-sandbox subchart installs hardcoded
  cluster-scoped `ClusterRole`/`ClusterRoleBinding` `agent-sandbox-controller` and
  4 hardcoded `*.agents.x-k8s.io` CRDs → collide across releases. node-sync's scanner
  is namespace-agnostic on one shared `/var/lib/centaur/overlays`. depcache is
  single-tenant-only.
- k3d-cluster-per-preview restores node-sync's "one node = one tenant" invariant.
- POC-CONFIRMED on the OVH box: overlay mount + Bidirectional→HostToContainer
  propagation works in k3s-in-docker, **provided each k3d cluster bind-mounts a REAL
  ext4 dir for `/var/lib/centaur`** (overlay upperdir cannot be on the node's overlay
  fs or on tmpfs). This is mandatory.

## Directory layout (lane ownership)
```
deploy/preview/ovh/
  CONTRACT.md            # foundation (do not edit in lanes)
  launcher.py            # [launcher-core] bearer-token HTTP API; shells to previewctl
  previewctl.py          # [launcher-core] k3d/helm/compose orchestrator
  requirements.txt       # [launcher-core] stdlib-only target (keep empty if possible)
  setup/                 # [box-setup]
    provision-box.sh       one-shot box provisioning (idempotent)
    validate-overlay.sh    first-run gate: overlay+propagation check in throwaway k3d
    janitor.sh             external idempotent TTL sweep
    launcher.service       systemd unit for the launcher
    janitor.cron           cron line for the janitor
    Caddyfile.tmpl         shared reverse proxy + wildcard TLS
    cloudflared.md         CF Tunnel setup (no CF Access on launcher host)
  tool/                  # [centaur-tool]
    atrium-preview         agent-facing CLI tool (calls launcher API)
    iron-proxy.md          iron-proxy host-allowlist + bearer-injection config
    AGENT_GUIDANCE.md      prompt guidance for agents using the tool
  README.md              # [docs] operator + agent overview
```

## Launcher API (KEEP identical to AWS launcher for drop-in tooling)
- `POST /previews`  body `{repo, ref, ttl_hours, requested_by, fresh?}` → `202 {id, phase, action}`
- `GET  /previews/<id>` → status object (fields below)
- `DELETE /previews/<id>` → destroy
- `GET  /healthz` → 200
- Auth: `Authorization: Bearer <ATRIUM_PREVIEW_LAUNCHER_TOKEN>` on all but /healthz.
- `repo` allowlist: `{"useatrium/atrium"}`. `ttl_hours` in [1, 72], default 24.

### Reuse-by-branch + in-place update (default)
`POST /previews` is **reuse-by-branch**: if a non-terminal preview already exists for
`(repo, ref)`, the new commit is pushed into it **in place** rather than building a new
stack — the k3d cluster, Postgres data, ports, MinIO bucket, caddy route, and the node's
warm images (incl. the fat agent image → warm sandboxes) are all kept. `action` in the
response is `created` | `updating`. The reuse decision is atomic under the store lock
(two same-branch creates can't both build), and concurrent updates of one preview are
serialized. Pass `fresh: true` to force a brand-new stack.

The update is change-detected (`git diff old..new`, patterns mirror `deploy/redeploy.sh`):
only the changed side rebuilds — surface swaps its image via `compose up` **preserving the
`.env` secrets** (regenerating them would lock the server out of its own Postgres); centaur
does `helm upgrade` with only changed images rebuilt and the rest retagged old→new (same
digest = no re-pull). A docs-only commit is a no-op TTL bump. An update **never tears the
preview down** — on failure it stays `ready` on the old code with `failure_message` set.

### Status object fields (KEEP)
`id, repo, ref, commit_sha, status, url, initial_url, expires_at, phase, phase_time,
ready_at, failure_message`. `status ∈ {provisioning, ready, failed, destroyed}`.

## IDs, paths, naming (locked)
- preview id: `prev-<sha12>-<rand4hex>` (unchanged from AWS `make_preview_id`).
- k3d cluster name: `preview-<id>`.
- per-preview real-fs root (ext4, bind-mounted into k3d): `/var/lib/atrium-preview/<id>/centaur`.
- k3d create (required flags):
  `k3d cluster create preview-<id> --no-lb --k3s-arg "--disable=traefik@server:0"
   --k3s-arg "--disable=servicelb@server:0"
   --volume /var/lib/atrium-preview/<id>/centaur:/var/lib/centaur@server:0`
- Surface compose project name: `preview-<id>`.
- subdomain: `<id>.preview.useatrium.com` → shared Caddy → this preview's server.
- Surface env reused from AWS: `AUTH_OPEN=1`, `AUTH_DEV_CODES=1`, `EMAIL_MODE=log`,
  random `SESSION_SECRET`/`APP_SIGNING_SECRET`/`PROVIDER_CREDENTIAL_SECRET`/`DB_PASSWORD`.
- object storage: per-preview **MinIO** (compose service), bucket per preview — NOT S3/IAM.

## Phases (report via status.json; order)
`packages → source → build-lock → surface-build → k3d-up → centaur-deploy →
surface-up → migrate → healthz → route → ready`  (or `failed` at any phase).

## Guardrails (MUST implement; absent in AWS version)
- `MAX_CONCURRENT_PREVIEWS` env (default 3). `POST /previews` returns **429** when the
  count of non-terminal previews ≥ cap.
- **Per-commit build lock**: serialize image builds for the same `commit_sha` (file lock
  under the state dir) so concurrent creates of one SHA don't double-build.
- **Idempotent destroy**: destroying an already-gone preview is a no-op success.
  Destroy removes k3d cluster + compose `down -v` + MinIO bucket + Caddy vhost. It must
  NEVER touch the shared wildcard cert or DNS.
- Janitor is EXTERNAL (cron) — in-process TTL is best-effort only.

## Networking (locked)
- Launcher reachable from prod Centaur via **CF Tunnel**, hostname e.g.
  `preview-launcher.useatrium.com`, **without CF Access** (bearer token is the only gate).
- Wildcard TLS `*.preview.useatrium.com` via Caddy DNS-01 (CF API token) — provisioned
  ONCE by provision-box.sh, never per preview.

## Warm caches (provision-box.sh responsibility) — the speed story
Resident on the box so on-demand builds skip the ~8-min node-sync Rust rebuild and pnpm
download that dominate the AWS 14-min cold deploy:
- base images (postgres, minio, caddy, rancher/k3s) pre-pulled
- local docker registry (golden per-SHA app + centaur images)
- warm pnpm store, cargo registry + `target/` cache, buildkit cache

## Trigger tool (centaur-tool)
`atrium-preview {create|status|destroy}` calls the launcher API. It does NOT hold the
token — iron-proxy injects `Authorization: Bearer <ATRIUM_PREVIEW_LAUNCHER_TOKEN>` for
requests to the launcher host and allowlists that host. Tool MUST enforce push-first
(warn if ref is not on origin), then create → poll → report id/sha/url/expiry/failure.
