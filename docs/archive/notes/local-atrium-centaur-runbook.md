# Local Atrium + Centaur Runbook

> ⚠️ **Largely superseded (2026-06-26).** Centaur is now **vendored inside this repo at
> `centaur/`** (via git subtree) — there is no separate `~/Code/centaur` clone, no `fork/main`
> deploy line, and no `gb/*` upstream-PR branches. The **"Branch Model"** section below
> describes that retired two-repo model and no longer applies. For how the fork works now,
> see [`centaur/ATRIUM_FORK.md`](../centaur/ATRIUM_FORK.md) and
> [`notes/centaur-vendoring.md`](centaur-vendoring.md). The local **build/deploy** steps below
> still work, but run them from **`~/Code/atrium/centaur`** (this repo's `centaur/`), not
> `~/Code/centaur`.

This is the local Mac workflow for running Atrium against a local Centaur
`api-rs` deployment in kind.

## Branch Model

Use upstream Centaur as the upstream source and Gary's fork as the Atrium deploy
line:

- `origin/main`: upstream `paradigmxyz/centaur` — the source of truth
- `fork/main`: Atrium's Centaur fork line; this is what the local Atrium stack
  should build and deploy
- `fork/gb/*`: feature branches pushed to Gary's fork for upstream PRs

Keep `fork/main` intentionally rebased or merged forward from `origin/main` when
we need upstream changes. Do not treat an old topic branch as the deploy line once
its commits have landed here.

For stacked Centaur work, rebase from the bottom up:

```sh
cd ~/Code/centaur
git fetch origin
git fetch fork
git checkout gb/session-cancel-api-rs
git rebase origin/main
git push --force-with-lease fork gb/session-cancel-api-rs

git checkout gb/api-rs-hitl-relay
git rebase --onto gb/session-cancel-api-rs <old-cancel-commit> gb/api-rs-hitl-relay
git push --force-with-lease fork gb/api-rs-hitl-relay
```

Independent Centaur features should branch directly from `origin/main`.

### Deploy line vs. upstream branches

The `gb/*` branches above are *upstream-shaped*: one feature each, destined for
PRs to paradigm. Atrium runs a combined fork image, so the **build source is
`fork/main`**, not any one feature branch. `ATRIUM_FORK.md` is the authority on
fork-only intent labels and migration numbering.

**Build local Centaur from this branch** so the deploy carries every Atrium fork
feature:

```sh
cd ~/Code/centaur
git fetch fork origin
git checkout main
git reset --hard fork/main
```

## Build And Deploy Centaur Locally

The local Atrium deployment expects Centaur at `http://host.docker.internal:18000`.

**Docker build env (required on this Mac):** Docker Desktop's credential helper
breaks `docker build`, but an empty `DOCKER_CONFIG` also hides the `buildx`
plugin that the Dockerfiles' `RUN --mount` needs. Use a clean config that keeps
the plugins, and enable BuildKit:

```sh
export DOCKER_CONFIG=/tmp/atrium-centaur-docker-config
mkdir -p "$DOCKER_CONFIG"; echo '{}' > "$DOCKER_CONFIG/config.json"
ln -sfn ~/.docker/cli-plugins "$DOCKER_CONFIG/cli-plugins"
export DOCKER_BUILDKIT=1
```

```sh
cd ~/Code/centaur            # on atrium/integration

just build-one api-rs
just build-one agent
docker build -f services/api-rs/crates/centaur-node-sync/Dockerfile \
  -t centaur-node-sync:latest services/api-rs

kind load docker-image \
  centaur-api-rs:latest \
  centaur-agent:latest \
  centaur-node-sync:latest \
  --name centaur

# Artifact capture: dedicated key on the api-rs pod (envFrom centaur-infra-env);
# api-rs propagates it to sandboxes. NOT the control-plane CENTAUR_API_KEY.
kubectl -n centaur patch secret centaur-infra-env --type merge \
  -p "{\"stringData\":{\"ARTIFACT_CAPTURE_API_KEY\":\"$(openssl rand -hex 32)\"}}"

CENTAUR_EXTRA_VALUES=~/Code/atrium/infra/values.local.yaml just deploy
kubectl -n centaur rollout restart deploy/centaur-centaur-api-rs
kubectl -n centaur rollout status deploy/centaur-centaur-api-rs --timeout=180s

# Sandbox scoped API egress (see note below) — required with iron-proxy disabled.
kubectl apply -f ~/Code/atrium/infra/sandbox-egress-api-rs.yaml

kubectl -n centaur port-forward deploy/centaur-centaur-api-rs 18000:8080
```

### Node-sync -> Atrium local networking

Node-sync runs inside the kind cluster and calls Atrium directly. The Atrium
server container must be reachable from the `kind` Docker network, and the Helm
values must allow egress to that exact IP.

For the usual local stack, attach the server container to the kind network before
or after starting compose:

```sh
docker network connect kind atrium-prod-server-1 2>/dev/null || true
docker inspect atrium-prod-server-1 \
  --format '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.IPAddress}}{{"\n"}}{{end}}'
```

`infra/values.local.yaml` assumes the `kind` network IP is `172.18.0.3` and sets
both `nodeSync.atriumBaseUrl` and `nodeSync.atriumEgress.ipBlock` accordingly.
If Docker assigns a different `kind` IP, replace both values in that file before
running `CENTAUR_EXTRA_VALUES=~/Code/atrium/infra/values.local.yaml just deploy`.

A healthy node-sync DaemonSet should log `capture: ... 0 errors`; `No route to
host` means the container is not attached to the `kind` network or the egress
IP/port does not match.

### Artifact capture: sandbox→api-rs egress gap

Verified end-to-end 2026-06-18, with one fix required. The capture worker in
each sandbox POSTs to `api-rs:8080`, but with iron-proxy **disabled** (local
values) no per-sandbox egress NetworkPolicy is created, and the cluster's static
sandbox egress policies key on the **legacy** `centaur.ai/managed: "true"` label
— while api-rs-managed sandboxes carry `centaur.ai/managed-by: api-rs`. So they
match no egress policy and `default-deny` blocks the POST (httpx ConnectTimeout).
`infra/sandbox-egress-api-rs.yaml` allows `managed-by: api-rs` sandboxes →
`api-rs:8080` (api-rs ingress already admits `managed-by: api-rs`).

**Proper fix (Centaur side, follow-up):** the api-rs k8s sandbox backend (or the
chart) should create this egress allowance for `managed-by: api-rs` sandboxes
when iron-proxy is off, rather than relying on this manual manifest.

In another shell:

```sh
curl http://127.0.0.1:18000/healthz
kubectl -n centaur get pods
```

There should be no `centaur.ai/managed=true` sandbox pods when idle.

## Build And Deploy Atrium Locally

```sh
cd ~/Code/atrium/surface
pnpm install --frozen-lockfile
pnpm --filter @atrium/web build

cd deploy
docker compose -p atrium-prod -f docker-compose.prod.yml --profile caddy up -d --build
curl http://127.0.0.1:${SERVER_HOST_PORT:-3001}/healthz
```

Local prod defaults used during api-rs testing:

- app: `http://127.0.0.1:18080`
- server: `http://127.0.0.1:13001`
- Centaur: `http://host.docker.internal:18000`

## Docker Desktop Credential Helper Slowdown

Observed on macOS Docker Desktop 29.2.1: `~/.docker/config.json` used
`"credsStore": "desktop"`. Cached public pulls such as
`docker pull docker/dockerfile:1.7` took seconds, while the same command with no
Docker credential store took about half a second. Direct
`docker-credential-osxkeychain` was fast; the slowdown was Docker Desktop's
`docker-credential-desktop` wrapper path.

Symptoms:

- `docker compose up -d --build` hangs or is very slow before real build output
- buildx appears stuck resolving `docker/dockerfile:1.7`
- retrying with an empty Docker config is fast

One-off workaround for public-image local builds:

```sh
mkdir -p /tmp/atrium-empty-docker-config
DOCKER_CONFIG=/tmp/atrium-empty-docker-config docker pull docker/dockerfile:1.7

cd ~/Code/atrium/surface
DOCKER_CONFIG=/tmp/atrium-empty-docker-config \
  ~/.docker/cli-plugins/docker-buildx build \
  --load \
  -t atrium-prod-server:latest \
  -f deploy/Dockerfile.server \
  .

cd deploy
~/.docker/cli-plugins/docker-compose \
  -p atrium-prod \
  -f docker-compose.prod.yml \
  --profile caddy \
  up -d --no-build server caddy
```

Persistent local options:

- Prefer changing `"credsStore": "desktop"` to `"credsStore": "osxkeychain"` if
  Docker Hub/private registry auth is needed and Docker Desktop does not rewrite
  it.
- Remove `credsStore` entirely if local builds only use public base images.
- Keep using a temporary `DOCKER_CONFIG` for automation so the global Docker
  Desktop login state is untouched.

Back up the config before changing it:

```sh
cp ~/.docker/config.json ~/.docker/config.json.bak.$(date +%Y%m%d%H%M%S)
```

Switch to direct macOS keychain:

```sh
jq '.credsStore = "osxkeychain"' ~/.docker/config.json > /tmp/docker-config.json
mv /tmp/docker-config.json ~/.docker/config.json
```

Or remove the credential store:

```sh
jq 'del(.credsStore)' ~/.docker/config.json > /tmp/docker-config.json
mv /tmp/docker-config.json ~/.docker/config.json
```

## macOS Privacy Prompts For `node`

macOS Full Disk Access cannot be granted silently by a normal shell command.
Apple requires a user-approved UI action or managed-device PPPC profile.

Useful command-assisted path:

```sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open -R /Applications/Codex.app/Contents/Resources/node
open -R /opt/homebrew/bin/node
```

In **System Settings -> Privacy & Security -> Full Disk Access**, enable:

- `Codex.app`
- `/Applications/Codex.app/Contents/Resources/node`
- `/opt/homebrew/bin/node` or the current Homebrew Cellar Node path

Restart Codex and shells after changing these settings. Homebrew Node upgrades
can change the real Cellar path and cause prompts again.

## Validation

```sh
cd ~/Code/atrium/surface
pnpm --filter @atrium/server typecheck
pnpm --filter @atrium/server test
pnpm --filter @atrium/centaur-client test
pnpm --filter @atrium/web build
pnpm e2e

cd ~/Code/centaur/services/api-rs
cargo fmt --check
cargo test -p centaur-session-runtime -p centaur-api-server -p centaur-session-sqlx

cd ~/Code/centaur/crates/harness-server
cargo fmt --check
cargo test
```
