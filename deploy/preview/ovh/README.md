# Atrium OVH Preview Environments

This is the production preview path for Atrium: each pushed branch gets a
disposable, full-stack preview on one dedicated, warm OVH host. Every preview
runs Centaur in its own k3d cluster, Surface and its Postgres and MinIO services
in a dedicated Compose project, and a Caddy vhost at
`<id>.preview.useatrium.com`. Previews expire automatically and can also be
destroyed explicitly.

This system supersedes the per-preview AWS EC2 approach in
[`../aws/`](../aws/) for production use. The AWS implementation remains useful
as historical context and a fallback reference.

## Why one k3d cluster per preview

A namespace per preview cannot isolate Centaur: the agent-sandbox chart creates
hardcoded cluster-scoped roles, bindings, and CRDs, while node-sync and depcache
also assume a single tenant per node. A separate k3d cluster restores that
boundary. The OVH proof of concept also confirmed that Centaur overlay mounts
propagate through k3s-in-Docker, provided every cluster bind-mounts a real ext4
directory at `/var/lib/centaur`. An overlay filesystem or tmpfs cannot serve as
the overlay upper directory, so the real-filesystem bind mount is required.

## Architecture

```text
agent
  |
  v
atrium-preview tool
  |
  v
iron-proxy (allowlists host and injects bearer token)
  |
  v
Cloudflare Tunnel
  |
  v
launcher.py
  |
  v
previewctl.py
  |
  +-- preview <id> ------------------------------------------+
      | k3d cluster: Centaur                                 |
      | Compose: Surface + Postgres + MinIO                  |
      | Caddy vhost                                          |
      +----------------------+-------------------------------+
                             |
                             v
                  <id>.preview.useatrium.com
```

See [`CONTRACT.md`](CONTRACT.md) for the source-of-truth component contract.

## Operator quickstart

Use a dedicated OVH host with approximately 22 GB of usable memory. From the
repository root, provision the warm box:

```sh
deploy/preview/ovh/setup/provision-box.sh
```

Before serving previews, run the mandatory overlay and mount-propagation gate:

```sh
deploy/preview/ovh/setup/validate-overlay.sh
```

Do not proceed unless its output contains exactly:

```text
POC_RESULT=CONFIRMED
```

Provisioning and launcher operation require these secrets and inputs:

- A narrowly scoped Cloudflare API token for Caddy's wildcard DNS-01 challenge.
- A strong `ATRIUM_PREVIEW_LAUNCHER_TOKEN` shared only by the launcher and the
  iron-proxy injection configuration.
- A configured `cloudflared` tunnel that exposes the launcher hostname, such as
  `preview-launcher.useatrium.com`, without Cloudflare Access.
- Wildcard DNS for `*.preview.useatrium.com` routed to the shared Caddy ingress.

Configure the tunnel as described in
[`setup/cloudflared.md`](setup/cloudflared.md). The bearer token is the
launcher's only authentication gate; agents never receive it directly. Caddy
obtains the wildcard certificate once during provisioning. Preview creation and
destruction must not modify the shared certificate or DNS.

The provisioner also warms base images, the pnpm and Cargo stores, BuildKit,
and the local Docker registry. Run the external TTL janitor from
[`setup/janitor.sh`](setup/janitor.sh) using the schedule in
[`setup/janitor.cron`](setup/janitor.cron); in-process expiry is only
best-effort.

## Keeping the box in sync (deploy path)

The launcher runs from a git checkout at `/opt/atrium`. A systemd timer
(`atrium-preview-deploy.timer`, every 10 min) runs
[`setup/deploy.sh`](setup/deploy.sh), which fetches the repo, hard-resets the
checkout to its deploy ref (`origin/master` by default), and restarts the
launcher **only** when the preview code changed — deferred while any preview is
provisioning, because a create runs in a launcher thread and a restart would
orphan a half-built preview. This makes drift self-correcting: the box tracks
the repo instead of accumulating un-pushed local edits.

- **Immediate deploy:** `sudo systemctl start atrium-preview-deploy.service`
  (or run `deploy.sh` directly).
- **Deliberate promotion instead of latest-master:** point the unit's
  `ATRIUM_PREVIEW_DEPLOY_REF` at `origin/deploy` and push to that branch, mirroring
  the production box's `master → deploy` flow.
- Any working-tree edit made on the box is saved to
  `/var/lib/atrium-preview/drift-<ts>.patch` before it is reset away, so a hotfix
  is recoverable — but commit it to the repo, or the next timer run discards it.
- The deployed SHA is recorded in `/var/lib/atrium-preview/deployed-sha`.

## Launcher API

The launcher is reached through the Cloudflare Tunnel. All endpoints except
`GET /healthz` require:

```http
Authorization: Bearer <ATRIUM_PREVIEW_LAUNCHER_TOKEN>
```

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/previews` | Create a preview; returns `202 {id, phase}`. |
| `GET` | `/previews/<id>` | Return the current status object. |
| `DELETE` | `/previews/<id>` | Destroy the preview idempotently. |
| `GET` | `/healthz` | Return `200`; no bearer token required. |

The create body is:

```json
{
  "repo": "useatrium/atrium",
  "ref": "feature/my-branch",
  "ttl_hours": 24,
  "requested_by": "@agent"
}
```

Only `useatrium/atrium` is allowed. `ttl_hours` defaults to 24 and must be from
1 through 72. The launcher resolves the pushed ref to an immutable commit SHA.
If the number of non-terminal previews reaches `MAX_CONCURRENT_PREVIEWS`
(default 3), create returns HTTP `429`.

Status responses retain these fields throughout the lifecycle:

```text
id, repo, ref, commit_sha, status, url, initial_url, expires_at, phase,
phase_time, ready_at, failure_message
```

`status` is one of `provisioning`, `ready`, `failed`, or `destroyed`. Deployment
progress is reported in `phase`; the ordered phases are:

```text
packages -> source -> build-lock -> surface-build -> k3d-up ->
centaur-deploy -> surface-up -> migrate -> healthz -> route -> ready
```

A deployment may enter `failed` at any phase. Use `failure_message` when
reporting the failure.

## Agent workflow

Agents use the packaged `atrium-preview` CLI rather than calling the launcher
directly.

1. Push the branch or ref to origin first. The tool warns when the ref is not on
   origin, and the launcher deploys the resolved commit rather than local work.
2. Run `atrium-preview create` for `useatrium/atrium`, the pushed ref, the
   desired TTL, and the requester.
3. Poll with `atrium-preview status` until the preview is `ready` or `failed`.
4. Report the preview id, ref, resolved SHA, status and phase, URL, expiry, and
   any failure message in chat.
5. Run `atrium-preview destroy` as soon as the preview is no longer needed.

Destroy is safe to repeat. It removes the preview's k3d cluster, Compose project
and volumes, MinIO bucket, and Caddy vhost, but leaves wildcard TLS and DNS
alone.

## Guardrails and capacity

- Keep `MAX_CONCURRENT_PREVIEWS` at or below the host's measured capacity. The
  default is 3, and the launcher rejects excess creates with HTTP `429`.
- Expect roughly three to four concurrent previews on a host with about 22 GB
  of usable memory. Each preview is a full Centaur and Surface deployment, and
  individual sandbox pods may use up to 4 GB.
- Always set a TTL within the 1-to-72-hour limit and run the external janitor.
  The launcher process alone is not a sufficient cost-control mechanism.
- Keep the repository allowlist restricted to `useatrium/atrium`.
- Do not put production data or production secrets in disposable previews.

## Who can reach a preview

Every preview vhost is gated at the shared Caddy, so a preview — which runs real
agents against a credential connected inside it, in an `AUTH_OPEN` app — is never
reachable by someone who merely guesses the URL. A shared token is the
containment boundary.

The gate is a **capability link**. An agent hands out
`https://<preview>/?k=<token>`; the first click mints a `Secure; HttpOnly;
SameSite=Lax` cookie and Caddy 302-redirects to the clean URL (the token is
stripped from the address bar and history). Every later request is authorized by
the cookie — one click, nothing to type. The cookie is matched with an anchored
regexp so a crafted cookie cannot spoof it, and it lives 72 h (longer than any
preview), so a session never expires mid-preview.

Cloudflare Access would be the nicer gate (per-person email allowlist), but it
requires the wildcard to be proxied through Cloudflare, and the box's free-plan
zone cannot get a Cloudflare edge certificate for a second-level wildcard
(`*.<preview-domain>`) without the paid Advanced Certificate Manager add-on. The
token gate keeps the model free and the wildcard DNS-only, with Caddy terminating
TLS via its own certificate. It can be upgraded to Access later (proxy the
wildcard + ACM, or move previews to a dedicated apex domain where the wildcard is
first-level and free Universal SSL covers it) without touching the preview stack.

The token lives in the launcher environment as `ATRIUM_PREVIEW_ACCESS_TOKEN` (a
URL-safe shared secret, e.g. `openssl rand -hex 24`); the launcher decorates the
reported preview URL with `?k=<token>` and **refuses to create a preview** while
it is unset, so a misprovisioned box cannot publish an unguarded preview. The
MinIO object path is deliberately left open: presigned URLs self-authenticate
(the signature is the gate) and a browser download carries no cookie for that
host anyway — the same posture as production's `atrium-files` host.

Per-commit build locks prevent simultaneous previews of one SHA from rebuilding
the same images twice. The warm host avoids the package installation, pnpm
download, and roughly eight-minute node-sync rebuild that dominated the AWS
path's approximately 14-minute cold deployment. Measure and record actual
time-to-ready on the first OVH deployments before promising a startup target.

## Known gaps and V2

- Add a warm pool so agents can claim an already-running preview nearly
  instantly.
- Warm golden application and Centaur images for each commit SHA before a claim.
- Add a native Atrium preview-status card. For now, the agent reports status,
  phase, URL, SHA, and expiry in chat.
- Use measurements from initial production deployments to prioritize further
  build, cache, and startup-speed work.
