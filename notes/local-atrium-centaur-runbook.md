# Local Atrium + Centaur Runbook

This is the local Mac workflow for running Atrium against a local Centaur
`api-rs` deployment in kind.

## Branch Model

Use upstream Centaur as the source of truth:

- `origin/main`: upstream `paradigmxyz/centaur`
- `fork/main`: mirror only; keep it synced for hygiene, but do not base work on it
- `fork/gb/*`: feature branches pushed to Gary's fork for upstream PRs

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

## Build And Deploy Centaur Locally

The local Atrium deployment expects Centaur at `http://host.docker.internal:18000`.

```sh
cd ~/Code/centaur

just build-one api-rs
just build-one agent

kind load docker-image centaur-api-rs:latest centaur-agent:latest --name centaur

CENTAUR_EXTRA_VALUES=~/Code/atrium/infra/values.local.yaml just deploy
kubectl -n centaur rollout restart deploy/centaur-centaur-api-rs
kubectl -n centaur rollout status deploy/centaur-centaur-api-rs --timeout=180s

kubectl -n centaur port-forward deploy/centaur-centaur-api-rs 18000:8080
```

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

