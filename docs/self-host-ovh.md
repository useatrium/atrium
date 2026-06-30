# Self-hosting Atrium + Centaur on a single OVH box

End-to-end runbook for standing up the full stack — Atrium surface (chat / notes /
artifacts / files), the Centaur agent runtime, and a Cloudflare front door — on one
OVH VPS. Written from a real bring-up; the **⚠️ Gotcha** callouts are the traps we
actually hit.

## Topology

```
                 Cloudflare edge (TLS + Access email gate)
                          │  (tunnel, outbound — no inbound app ports)
   atrium.<domain> ───────┤
   atrium-files.<domain> ─┘
                          │
          ┌───────────────▼──────────────── OVH VPS (Ubuntu, 1 box) ───────────────┐
          │  cloudflared (systemd)                                                 │
          │     → Caddy 127.0.0.1:80  ──► server :3001 ──► Postgres / MinIO         │  Docker
          │     → MinIO  127.0.0.1:9000 (presigned files)                          │  compose
          │                                                                        │
          │  k3s ── api-rs :8080 (NodePort) ── agent-sandbox controller ── sandbox │  k3s
          │         └ Postgres (bundled)        pods (codex/claude)                │
          └────────────────────────────────────────────────────────────────────────┘
```

- **Surface** runs in Docker compose (`surface/deploy/`).
- **Centaur** runs in single-node k3s (Helm chart at `centaur/contrib/chart`).
- The surface reaches api-rs over a k3s **NodePort** via the Docker bridge gateway.
- All app ports bind **127.0.0.1**; the only public reach is the Cloudflare tunnel
  (and **Cloudflare Access** is the invite gate — Atrium's own login is self-service,
  not invite-only).

## Prerequisites

- An OVH **VPS-4** (8 vCPU / 24 GB / ~200 GB NVMe) — local NVMe beats Public-Cloud
  block storage for Postgres, and the VPS line ships a free daily backup.
- A domain whose **DNS is on Cloudflare** (zone active).
- For agents: each user brings their own **Codex** login (connected in the Atrium UI).

---

## Phase 1 — Provision + reach the box

1. Order the VPS with **Ubuntu 24.04/26.04 LTS** and a US (or nearest) region.
2. OVH ships the `ubuntu` user with an **expired password** → first login forces a
   change. Do it in a *real terminal* (the change dialog needs a TTY):
   ```sh
   ssh ubuntu@<VPS_IP>     # paste OVH password, set a new one when prompted
   ```
3. Install your SSH key, then verify key login works **before** disabling passwords:
   ```sh
   ssh-copy-id -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ed25519 ubuntu@<VPS_IP>
   ssh -i ~/.ssh/id_ed25519 ubuntu@<VPS_IP> 'echo ok; sudo -n true && echo sudo-nopass'
   ```

## Phase 2 — Base hardening (on the box)

```sh
# swap (build/agent headroom)
sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq rsync docker.io docker-compose-v2 docker-buildx
sudo usermod -aG docker ubuntu && sudo systemctl enable --now docker

# key-only SSH
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/99-atrium.conf
sudo systemctl reload ssh
```

> ⚠️ **Gotcha — sshd "first value wins."** Cloud-init drops
> `/etc/ssh/sshd_config.d/50-cloud-init.conf` with `PasswordAuthentication yes`, read
> *before* your `99-` file, so password auth stays on. Fix it at the source and stop
> cloud-init re-enabling it:
> ```sh
> sudo sed -i -E 's/^\s*PasswordAuthentication\s+yes/PasswordAuthentication no/I' /etc/ssh/sshd_config.d/*.conf
> echo 'ssh_pwauth: false' | sudo tee /etc/cloud/cloud.cfg.d/99-atrium-ssh.cfg
> sudo systemctl reload ssh && sudo sshd -T | grep -i '^passwordauthentication'   # must be: no
> ```

> ⚠️ **Gotcha — BuildKit.** Ubuntu's `docker.io` defaults to the legacy builder;
> Centaur's Dockerfiles use `RUN --mount=type=cache`. Install `docker-buildx` (above)
> and always export `DOCKER_BUILDKIT=1` for image builds.

> ⚠️ **Docker bypasses ufw.** Published Docker ports skip ufw rules, so binding to
> `127.0.0.1` (not a firewall) is the real protection for app ports.

## Phase 3 — Atrium surface

```sh
# get the code onto the box (rsync the working tree, or git clone)
rsync -az --exclude '.git/' --exclude 'node_modules/' --exclude 'target/' \
  -e 'ssh -i ~/.ssh/id_ed25519' ./ ubuntu@<VPS_IP>:/home/ubuntu/atrium/

# on the box: write a production .env
cd ~/atrium/surface/deploy
# generate secrets: openssl rand -hex 32 (DB/MinIO), openssl rand -base64 32 (SESSION_SECRET)
# key settings: BIND_HOST=127.0.0.1, DB/MinIO/server on loopback, AUTH_OPEN=1
#   (Cloudflare Access is the gate), S3_ENDPOINT=http://minio:9000 (flip to the public
#   files host once the tunnel is up), CENTAUR_* filled in Phase 6.

# web SPA (build in a node container to avoid host Node)
docker run --rm -v ~/atrium/surface:/app -w /app node:24-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @atrium/web build'

# bring up db + minio + server, then Caddy on loopback (tunnel override)
cd ~/atrium/surface/deploy
cat > docker-compose.tunnel.yml <<'YAML'
services:
  caddy:
    ports: !override
      - "127.0.0.1:80:80"
YAML
sudo docker compose -f docker-compose.prod.yml up -d --build db minio server
sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --profile caddy up -d caddy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/healthz   # 200
```

> ⚠️ **Gotcha — a stale `.env` wins.** The server only writes `.env` if absent, so an
> `.env` carried over from another machine (e.g. a Tailscale dev box with
> `BIND_HOST=0.0.0.0`) silently takes over — wrong ports and **MinIO exposed on
> `0.0.0.0`**. Overwrite it with a fresh production `.env`.

> ⚠️ **Gotcha — Postgres password.** Postgres only sets its password on first init.
> If you change `DB_PASSWORD` after the volume exists, the server can't auth. On a
> fresh test box just `docker compose down -v` and re-up.

## Phase 4 — Cloudflare tunnel + Access (no inbound ports)

```sh
# on the box
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /tmp/cloudflared && sudo install -m755 /tmp/cloudflared /usr/local/bin/cloudflared
cloudflared tunnel login            # prints a URL → open it, authorize <domain>
cloudflared tunnel create atrium    # writes ~/.cloudflared/<TID>.json

sudo mkdir -p /etc/cloudflared && sudo cp ~/.cloudflared/<TID>.json /etc/cloudflared/
sudo tee /etc/cloudflared/config.yml <<EOF
tunnel: <TID>
credentials-file: /etc/cloudflared/<TID>.json
ingress:
  - hostname: atrium.<domain>
    service: http://localhost:80
  - hostname: atrium-files.<domain>
    service: http://localhost:9000
  - service: http_status:404
EOF
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

**Access gate via API** (needs a token with *Access: Apps and Policies — Edit* and
*Access: Organizations… — Edit*; account id from the Cloudflare dashboard):

```sh
ACC=<account_id>; TOKEN=<cf_api_token>
API=https://api.cloudflare.com/client/v4
# create the self-hosted app + an allow policy (email allowlist)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/accounts/$ACC/access/apps" --data '{
    "name":"Atrium","domain":"atrium.<domain>","type":"self_hosted","session_duration":"730h",
    "policies":[{"name":"Allowed","decision":"allow","include":[{"email":{"email":"you@example.com"}}],"precedence":1}]}'
# route DNS last, so the host is gated before it resolves
cloudflared tunnel route dns atrium atrium.<domain>
```

> ⚠️ **Gotcha — token TTL.** If the API token has a *Start Date* in the future or an
> *End Date* in the past, `/user/tokens/verify` says "active" but every call 401s with
> `Authentication error`. Leave the TTL dates blank.

> ⚠️ **Gotcha — Zero Trust must be enabled once in the dashboard.** A brand-new org
> can't be created purely by API (`access.api.error.invalid_auth_domain` on every team
> name). Visit **one.dash.cloudflare.com**, enable Access (Free plan) once — it
> auto-assigns a team domain — then app/policy/DNS all work via API.

> Verify the gate: an unauthenticated request must **302 → the Access login**, not 200:
> `curl -sI https://atrium.<domain> | grep -i location`

## Phase 5 — Files host (MinIO presigned uploads)

The `atrium-files.<domain>` ingress (Phase 4) carries MinIO. Point the surface at it:

```sh
sed -i 's|^S3_ENDPOINT=.*|S3_ENDPOINT=https://atrium-files.<domain>|' ~/atrium/surface/deploy/.env
sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d server
```

- **No Access** on the files host — presigned-URL signatures are the auth; Access would
  break the browser PUT (cross-subdomain cookie).
- ⚠️ Cloudflare's free plan caps proxied request bodies at **100 MB** (upload ceiling).

## Phase 6 — Centaur agent runtime (k3s)

```sh
# cluster + tooling
curl -sfL https://get.k3s.io | sh -
sudo chmod 644 /etc/rancher/k3s/k3s.yaml
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown ubuntu:ubuntu ~/.kube/config
sudo ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
export KUBECONFIG=$HOME/.kube/config
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash
sudo apt-get install -y just

# the Justfile needs git metadata
cd ~/atrium && git init -q && git -c user.email=x -c user.name=x commit --allow-empty -qm snapshot

# build the fork images (api-rs + iron-proxy + the fat sandbox image)
cd ~/atrium/centaur
for s in api-rs iron-proxy sandbox; do DOCKER_BUILDKIT=1 just build-one "$s"; done

# import Docker images into k3s containerd (k3s != Docker runtime)
for i in centaur-api-rs centaur-iron-proxy centaur-agent; do
  docker save "$i:latest" | sudo k3s ctr images import -
done

# secrets: env backend, dummy OP/Slack (Slack+1Password disabled), generated LOCAL_DEV_API_KEY
export OP_SERVICE_ACCOUNT_TOKEN=dummy OP_VAULT=dummy SLACK_BOT_TOKEN=dummy SLACK_SIGNING_SECRET=dummy
export SLACKBOT_API_KEY=$(openssl rand -hex 32) LOCAL_DEV_API_KEY=$(openssl rand -hex 32)
just bootstrap-secrets
# api-rs also requires this key (not seeded by bootstrap):
kubectl -n centaur patch secret centaur-infra-env --type merge \
  -p "{\"stringData\":{\"ARTIFACT_CAPTURE_API_KEY\":\"$(openssl rand -hex 32)\"}}"

# deploy with Atrium overrides + round-1 simplifications
helm upgrade --install centaur contrib/chart -n centaur --create-namespace \
  -f contrib/chart/values.dev.yaml -f ../infra/values.local.yaml \
  --set repoCache.enabled=false \
  --set nodeSync.overlayProvisioning.enabled=false \
  --set networkPolicy.enabled=false
kubectl -n centaur rollout status deploy/centaur-centaur-api-rs
```

**Wire the surface → api-rs** (NodePort reached via the Docker bridge gateway):

```sh
kubectl -n centaur patch svc centaur-centaur-api-rs -p '{"spec":{"type":"NodePort"}}'
NP=$(kubectl -n centaur get svc centaur-centaur-api-rs -o jsonpath='{.spec.ports[0].nodePort}')
GW=$(docker network inspect deploy_default -f '{{(index .IPAM.Config 0).Gateway}}')
LDK=$(kubectl -n centaur get secret centaur-infra-env -o jsonpath='{.data.LOCAL_DEV_API_KEY}' | base64 -d)
cd ~/atrium/surface/deploy
sed -i "s|^CENTAUR_BASE_URL=.*|CENTAUR_BASE_URL=http://$GW:$NP|" .env
sed -i "s|^CENTAUR_API_KEY=.*|CENTAUR_API_KEY=$LDK|" .env
sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d server
```

> ⚠️ **Gotcha — `CreateContainerConfigError`** on api-rs means a referenced secret key
> is missing — most often `ARTIFACT_CAPTURE_API_KEY` (patch it as above).

> ⚠️ **Gotcha — sandbox stuck `Init` / "did not become running".** Three independent
> causes we hit, all silent: (a) the `overlay-manifest-writer` init container needs the
> `centaur-node-sync` image you didn't build → disable overlay provisioning; (b)
> `repo-cache` crashloops on `/opt/centaur/gitconfig` perms → `repoCache.enabled=false`;
> (c) the deny-by-default **NetworkPolicy** blocks the sandbox's egress to GitHub (tools
> clone) *and* `api.openai.com` (Codex, since iron-proxy is off) → `networkPolicy.enabled=false`.
> The three `--set` flags above clear all three.

Smoke-test a sandbox spawns:
```sh
DC="kubectl exec -n centaur deploy/centaur-centaur-api-rs --"
$DC curl -s -X POST 'http://localhost:8080/api/session/cli%3Asmoke' -d '{"harness_type":"codex","on_harness_conflict":"restart"}'
$DC curl -s -X POST 'http://localhost:8080/api/session/cli%3Asmoke/execute' \
  -d '{"input_lines":["{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"PONG\"}]}}"]}'
kubectl get pods -n centaur | grep asbx   # asbx-* → 1/1 Running
```

## Phase 6b — Artifact capture (optional)

Capture ships agents' file changes to Atrium's CAS ledger via the privileged
`node-sync` DaemonSet. It's off in the round-1 deploy above; enable it like this.

```sh
# build + import the node-sync image (skipped earlier)
cd ~/atrium/centaur && DOCKER_BUILDKIT=1 just build-one node-sync
docker save centaur-node-sync:latest | sudo k3s ctr images import -

# the DaemonSet (k3s) must reach the surface server (Docker). Publish the surface
# on the cni0 host IP (10.42.0.1) — k3s pods reach the host there and it's internal
# (not public). Append to the compose tunnel override → server.ports, then recreate:
#   services: { server: { ports: [ "10.42.0.1:3001:3001" ] } }
cd ~/atrium/surface/deploy
sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d server

# re-enable node-sync + overlay-provisioning, point atriumBaseUrl at cni0
cd ~/atrium/centaur
helm upgrade centaur contrib/chart -n centaur \
  -f contrib/chart/values.dev.yaml -f ../infra/values.local.yaml \
  --set repoCache.enabled=false --set networkPolicy.enabled=false \
  --set nodeSync.enabled=true --set nodeSync.overlayProvisioning.enabled=true \
  --set nodeSync.atriumBaseUrl=http://10.42.0.1:3001
kubectl get pods -n centaur | grep node-sync   # 1/1 Running
```

> ⚠️ **Gotcha — the surface needs `ARTIFACT_CAPTURE_API_KEY`, matching Centaur's.**
> The surface `.env` has **no such line by default**, so the server runs with an
> *empty* key and node-sync gets **401**. Set the same value on both sides:
> ```sh
> KEY=$(kubectl -n centaur get secret centaur-infra-env -o jsonpath='{.data.ARTIFACT_CAPTURE_API_KEY}' | base64 -d)
> cd ~/atrium/surface/deploy
> grep -q '^ARTIFACT_CAPTURE_API_KEY=' .env || echo "ARTIFACT_CAPTURE_API_KEY=$KEY" >> .env
> sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d server
> ```
> Confirm in `kubectl logs -n centaur <node-sync-pod>`: requests should be 200 (a
> `404` for a thread key you created directly in Centaur is fine — only real
> Atrium-spawned sessions exist in the surface DB), **never 401**.

> Note: `infra/values.local.yaml` hardcodes `nodeSync.atriumBaseUrl` to the old
> **kind** IP `172.18.0.3` — the `--set` above overrides it for the k3s+compose
> topology. NetworkPolicy stays off so node-sync can reach `10.42.0.1`.

## Phase 7 — Agents actually run (per-user BYO Codex)

In the Atrium UI, each user **connects their Codex login** (`PUT
/api/me/provider-credentials/codex`). On spawn, Atrium injects that user's
`CODEX_AUTH_JSON` per-session (env-injection; iron-proxy disabled), and the sandbox
calls the LLM directly. Then spawn an agent and watch it respond.

## Round-1 deferred hardening (re-tighten later)

- **iron-proxy off** → token rides into the sandbox (env-injection). The
  "token-never-in-the-box" proxy path is the hardening fast-follow.
- **NetworkPolicy off** → open sandbox egress (required while iron-proxy is off).
- **Artifact capture (node-sync)** — disabled in the *base* deploy; **Phase 6b** shows
  how to enable it (build the image, publish the surface on cni0, fix `atriumBaseUrl`).
  Still rougher than the rest: it's a privileged DaemonSet on open egress.
- **repo-cache off** → tools direct-cloned (open egress). Fix its gitconfig perms to
  re-enable the per-node cache.

## Operations

- **Backups (do this!):** OVH redundancy ≠ backup. Cron `pg_dump` + a MinIO sync to
  free-egress object storage (R2 / B2), plus OVH volume/VPS snapshots. A reboot never
  loses data; backups cover rebuild / corruption / fat-finger.
- **Rotate** any API token that ever touched a log.
- **Health:** `curl localhost/healthz`, `kubectl get pods -n centaur`,
  `cd centaur && just debug-sandbox`.
- **Restart resilience.** The compose stacks ship with **no restart policy**, so they
  don't survive a reboot or `systemctl restart docker`. Pin them (do this *before* any
  docker restart): `sudo docker update --restart=unless-stopped $(sudo docker ps -q)`.
- **Cap the Docker build cache.** Ubuntu's `docker.io` has no GC ceiling, so the BuildKit
  cache grows unbounded (ours hit 26 GB after the Centaur builds). Cap + reclaim:
  ```sh
  sudo tee /etc/docker/daemon.json <<'JSON'
  { "builder": { "gc": { "enabled": true,
    "policy": [ { "reservedSpace": "5GB", "maxUsedSpace": "20GB" } ] } } }
  JSON
  sudo docker builder prune -f && sudo systemctl restart docker   # bounces containers ~10s
  ```

## Dev loop — rebuild & reload

**Surface (Docker)** — rebuild + recreate in one step (~30 s, esbuild bundle):
```sh
cd ~/atrium/surface/deploy
sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d --build server
# web SPA: rebuild dist (Caddy serves it live, no restart needed)
docker run --rm -v ~/atrium/surface:/app -w /app node:24-alpine \
  sh -c 'corepack enable && pnpm --filter @atrium/web build'
```
For *true* hot reload, run the server in dev mode (`pnpm dev` / `tsx watch`, source
mounted) instead of the baked prod image.

**Centaur (k3s)** — the image has to reach containerd, then the pod reloads. Loops,
fastest first:
- **Tilt (hot loop):** `cd ~/atrium/centaur && tilt up` — watches source, rebuilds only
  changed images, pushes to the local registry, redeploys. Needs the registry below.
- **Local registry (recommended for the manual loop):** run `registry:2` on
  `localhost:5000` + a k3s mirror so it resolves the chart's bare `:latest` tags:
  ```sh
  docker run -d --restart=always -p 127.0.0.1:5000:5000 --name registry registry:2
  sudo tee /etc/rancher/k3s/registries.yaml <<'YAML'
  mirrors:
    docker.io:
      endpoint: ["http://localhost:5000"]
  YAML
  sudo systemctl restart k3s
  # then: only changed layers push
  cd ~/atrium/centaur && just build-changed && just _push-registry \
    && kubectl rollout restart deploy/centaur-centaur-api-rs -n centaur
  ```
- **Import (no registry — what this guide used):** `just build-one <svc>` →
  `docker save centaur-<svc>:latest | sudo k3s ctr images import -` →
  `kubectl rollout restart deploy/…`. Simplest, slowest (saves the whole image).

> An agent editing the platform's own source runs in an **isolated sandbox** — its
> changes land in the CAS ledger, not `~/atrium`. To rebuild from agent edits, pull them
> into the host source first (git/PR), then run a loop above.
