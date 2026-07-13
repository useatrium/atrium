# Self-hosting Atrium + Centaur on a single OVH box

End-to-end runbook for standing up the full stack — Atrium surface (chat / notes /
artifacts / files), the Centaur agent runtime, and a Cloudflare front door — on one
OVH VPS. Written from a real bring-up; the **⚠️ Gotcha** callouts are the traps we
actually hit.

This is the complete **worked example** for the general guide at
[self-hosting.md](self-hosting.md): one real, specific topology (a single VPS
behind a Cloudflare tunnel + Access gate). Almost nothing here is OVH-specific —
it applies to any Ubuntu box. For the architecture, the required-vs-optional
dependency breakdown, and other topologies (private tailnet, plain Caddy TLS),
start with the general guide.

## Topology

```
                 Cloudflare edge (TLS + Access email gate)
                          │  (tunnel, outbound — no inbound app ports)
   atrium.<domain> ───────┤
   atrium-files.<domain> ─┤
   livekit.<domain> ──────┘   signaling tunnel → localhost:7880
                          │
   turn.<domain> ──────────── DNS-only → OVH public IP
                          │
          ┌───────────────▼──────────────── OVH VPS (Ubuntu, 1 box) ───────────────┐
          │  cloudflared (systemd)                                                 │
          │     → Caddy 127.0.0.1:80  ──► server :3001 ──► Postgres / MinIO         │  Docker
          │     → MinIO  127.0.0.1:9000 (presigned files)                          │  compose
          │     → LiveKit localhost:7880 (signaling WebSocket only)                 │
          │                                                                        │
          │  LiveKit (host network): public 443/TURN-TLS, 3478/UDP, 7881/TCP,      │  Docker
          │                          50000-60000/UDP media                         │
          │                                                                        │
          │  k3s ── api-rs :8080 (NodePort) ── agent-sandbox controller ── sandbox │  k3s
          │         └ Postgres (bundled)        pods (codex/claude)                │
          └────────────────────────────────────────────────────────────────────────┘
```

- **Surface** runs in Docker compose (`surface/deploy/`).
- **Centaur** runs in single-node k3s (Helm chart at `centaur/contrib/chart`).
- The surface reaches api-rs over a k3s **NodePort** via the Docker bridge gateway.
- All app ports bind **127.0.0.1**. App, files, and LiveKit signaling enter
  through the Cloudflare tunnel; the direct public ports are the LiveKit
  TURN/media ports listed in Phase 5b. **Cloudflare Access** is the invite gate
  for the app host — Atrium's own login is self-service, not invite-only.
- **LiveKit** is split by protocol: signaling is tunneled from
  `livekit.<domain>` to `localhost:7880`; media, ICE TCP fallback, and TURN stay
  direct on the OVH host. Only `turn.<domain>` is DNS-only to the OVH IP. Do not
  proxy LiveKit media, ICE TCP, or TURN through the app's HTTP Caddy tunnel.

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
# generate secrets: openssl rand -hex 32 (DB/MinIO and ARTIFACT_CAPTURE_API_KEY),
# openssl rand -base64 32 (SESSION_SECRET). Generate ARTIFACT_CAPTURE_API_KEY
# now; Phase 5 copies this same value into Centaur.
# key settings: BIND_HOST=127.0.0.1, DB/MinIO/server on loopback, AUTH_OPEN=1
#   (Cloudflare Access is the gate), S3_ENDPOINT=http://minio:9000 (flip to the public
#   files host once the tunnel is up), ARTIFACT_CAPTURE_API_KEY=<generated hex>,
#   CENTAUR_* filled in Phase 6.
# The server creates the S3_BUCKET at boot (retrying until the store is up) and
# /healthz stays 503 until that first succeeds — a health-gated deploy fails
# loudly if storage is misconfigured instead of 500ing every capture silently
# (#215). Manual fallback: docker exec deploy-minio-1 sh -c
#   'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb local/atrium-files'

# web SPA (build in a node container to avoid host Node)
docker run --rm -v ~/atrium/surface:/app -w /app node:24-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @atrium/web build'

# deploy/build state belongs outside the checkout
test ! -d ~/atrium/surface/.pnpm-store

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

> **Boot error — `unsafe service publication bind`.** Production Compose passes
> the effective host publications into the server, which prints the server,
> object-storage, and database bind addresses before boot. If a stale `.env` sets
> `BIND_HOST=0.0.0.0` (or an IPv6 wildcard), the server refuses to start because
> that publishes MinIO and Surface on every interface; Docker bypasses ufw. Set
> `BIND_HOST=127.0.0.1` in `.env`, then recreate `server`. A wildcard
> `DB_BIND_HOST` fails similarly; keep it at `127.0.0.1`.

> ⚠️ **Gotcha — Postgres password.** Postgres only sets its password on first init.
> If you change `DB_PASSWORD` after the volume exists, the server can't auth. On a
> fresh test box just `docker compose down -v` and re-up.

> ⚠️ **Gotcha — pnpm store drift.** Production deploy/build cache belongs outside
> `~/atrium`, under the explicit host deploy state area
> (`${ATRIUM_DEPLOY_STATE_DIR:-<repo-parent>/atrium-deploy}`). A
> `~/atrium/surface/.pnpm-store` directory is stale box-local state, not part of
> the repo or runtime contract; remove it after confirming no host-local pnpm
> process is using it.

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
  - hostname: livekit.<domain>
    service: http://localhost:7880
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
cloudflared tunnel route dns atrium atrium-files.<domain>
cloudflared tunnel route dns atrium livekit.<domain>
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

Do not put Cloudflare Access in front of `atrium-files.<domain>` or
`livekit.<domain>`. The files host uses presigned URLs, and LiveKit signaling
uses room tokens minted by Atrium.

## Phase 5 — Files host (MinIO presigned uploads)

The `atrium-files.<domain>` ingress (Phase 4) carries MinIO. Point the surface at it:

```sh
sed -i 's|^S3_ENDPOINT=.*|S3_ENDPOINT=https://atrium-files.<domain>|' ~/atrium/surface/deploy/.env
sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d server
```

- **No Access** on the files host — presigned-URL signatures are the auth; Access would
  break the browser PUT (cross-subdomain cookie).
- ⚠️ Cloudflare's free plan caps proxied request bodies at **100 MB** (upload ceiling).

## Phase 5b — Voice calls (signaling tunnel + direct TURN/media)

Keep Atrium app HTTP, app WebSockets, files, and LiveKit signaling behind the
Cloudflare tunnel. Keep WebRTC media, ICE TCP fallback, and TURN direct on the
OVH host because they are not HTTP traffic.

DNS and Cloudflare records:

- `atrium.<domain>` uses the Cloudflare Tunnel route to local Caddy
- `atrium-files.<domain>` uses the Cloudflare Tunnel route to MinIO, with no
  Cloudflare Access policy
- `livekit.<domain>` uses the Cloudflare Tunnel route to `http://localhost:7880`
  for LiveKit signaling only
- `turn.<domain>` is DNS-only A/AAAA to the OVH public IP and matches
  `LIVEKIT_TURN_DOMAIN` in `~/atrium/surface/deploy/.env`

Current Gary/OVH names: `atrium.garybasin.com` and
`atrium-files.garybasin.com` are tunnel routes, `livekit.garybasin.com` is a
tunnel route to `localhost:7880`, and `turn.garybasin.com` is DNS-only to the
OVH IP.

The `cloudflared` ingress from Phase 4 must include LiveKit signaling:

```yaml
ingress:
  - hostname: atrium.<domain>
    service: http://localhost:80
  - hostname: atrium-files.<domain>
    service: http://localhost:9000
  - hostname: livekit.<domain>
    service: http://localhost:7880
  - service: http_status:404
```

Public inbound ports for direct LiveKit traffic:

- `443/tcp` for TURN/TLS; public app Caddy must not bind this port
- `7881/tcp` for ICE TCP fallback
- `3478/udp` for TURN/UDP and STUN
- `50000-60000/udp` for LiveKit media
- `80/tcp` only if the TURN certificate flow needs HTTP-01/standalone ACME
  issuance or renewal; DNS-01 issuance does not need it

Do not expose public `7880/tcp`; cloudflared reaches it locally. Do not route the
direct LiveKit ports through cloudflared or the HTTP Caddyfile. Cloudflare Tunnel
and local Caddy remain for Atrium app HTTP, app WebSockets, files, and LiveKit
signaling only.

Generate LiveKit keys and set the surface env. `LIVEKIT_TURN_DOMAIN` in
`~/atrium/surface/deploy/.env` is the source of truth for the TURN hostname:
it drives DNS intent, the certbot live directory, compose's certificate mounts,
and the deploy-generated runtime LiveKit config under
`${ATRIUM_DEPLOY_STATE_DIR}/surface`. Do not edit the committed
`surface/deploy/livekit.yaml` on the box to set `turn.domain`; it is a repo
template, not the box-local source of truth. The server reads `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.

```sh
cd ~/atrium/surface/deploy
docker run --rm livekit/livekit-server:v1.13 generate-keys

sed -i 's|^LIVEKIT_URL=.*|LIVEKIT_URL=wss://livekit.<domain>|' .env
sed -i 's|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=<generated-key>|' .env
sed -i 's|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=<generated-secret>|' .env
if grep -q '^LIVEKIT_TURN_DOMAIN=' .env; then
  sed -i 's|^LIVEKIT_TURN_DOMAIN=.*|LIVEKIT_TURN_DOMAIN=turn.<domain>|' .env
else
  echo 'LIVEKIT_TURN_DOMAIN=turn.<domain>' >> .env
fi
```

Add the APNs production settings. EAS internal/ad-hoc, TestFlight, and App Store
builds use production APNs tokens, so keep `APNS_SANDBOX=0` unless the device is
running a true development-signed iOS build:

```sh
cat >> .env <<'EOF'
APNS_TEAM_ID=GS83M3FS29
APNS_KEY_ID=C5NS4JB9Y4
APNS_AUTH_KEY_P8=<contents of the .p8 key, raw or base64>
APNS_BUNDLE_ID=chat.atrium.app
APNS_SANDBOX=0

# Android ringing is deferred until there is an Android test device/build.
FCM_PROJECT_ID=
FCM_SERVICE_ACCOUNT_JSON=
EOF
```

Issue a Let's Encrypt certificate for the TURN hostname and keep renewal wired.
Prefer DNS-01 with Cloudflare credentials because it avoids opening `80/tcp`.
If you use standalone HTTP-01, open `80/tcp` for issuance and renewal and make
sure the ACME server can bind the public interface.

The committed `docker-compose.prod.yml` already mounts certbot's live paths based
on `LIVEKIT_TURN_DOMAIN`; do not create a cert-specific compose override for the
normal OVH topology. Inside the LiveKit container the paths are:

- `/etc/livekit/turn.crt`
- `/etc/livekit/turn.key`

On the host they come from:

- `/etc/letsencrypt/live/${LIVEKIT_TURN_DOMAIN}/fullchain.pem`
- `/etc/letsencrypt/live/${LIVEKIT_TURN_DOMAIN}/privkey.pem`

```sh
export LIVEKIT_CONFIG_FILE="$(./prepare-livekit-config.sh)"
sudo -E docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --profile caddy --profile livekit \
  up -d server caddy livekit
```

The current repo provides the renewal script at
`~/atrium/surface/deploy/renew-turn-cert.sh`. It runs `certbot renew`, restores
Caddy on exit, and restarts LiveKit only when certbot's deploy hook records a
renewed cert in `/var/lib/letsencrypt/atrium-turn-renewed-at`.

Install or refresh the systemd timer from the repo:

```sh
~/atrium/surface/deploy/install-turn-renewal.sh
```

Then audit that the timer points at the repo-managed wrapper:

```sh
systemctl list-timers --all '*turn*' '*cert*'
systemctl cat atrium-renew-turn-cert.service atrium-renew-turn-cert.timer
```

Do not replace it with an inline compose restart command; the script preserves
Caddy and only restarts LiveKit after an actual renewal.

Smoke checklist:

- API: `curl -s https://atrium.<domain>/auth/methods | jq '.calls == true'`
- Browser: a two-party web call starts, rings, joins, and passes audio
- Active-call rejoin: reload during an active call and confirm the participant can rejoin
- Manual iOS/APNs smoke: an on-device build with the app killed rings through APNs

## Phase 6 — Centaur agent runtime (k3s)

> **⚠️ Gotcha — disable k3s Traefik + ServiceLB, or it steals Caddy's port 80.**
> Caddy (Docker) is the ingress on host `:80`/`:443`, and api-rs is reached over a
> NodePort — so k3s's bundled Traefik/ServiceLB are unused. Left enabled, the
> `svclb-traefik` pod binds host `:80`/`:443` via a hostPort, and its CNI DNAT rule
> **shadows Caddy's** `127.0.0.1:80 → caddy` rule. Then `cloudflared → localhost:80`
> lands on Traefik (a blank `404 page not found`) instead of Caddy — the whole site
> 404s. It can stay dormant for a while and surface only after a `docker`/`k3s`
> restart reshuffles iptables ordering. The `config.yaml` below disables both. (To
> fix a live cluster without reinstalling: `kubectl -n kube-system patch svc traefik
> -p '{"spec":{"type":"ClusterIP"}}'` frees the ports immediately, but is **not**
> durable — set the `disable:` list and `systemctl restart k3s` for a permanent fix.)

```sh
# cluster + tooling
# Pre-seed k3s config BEFORE install so first boot already excludes Traefik/ServiceLB.
# write-kubeconfig-mode keeps k3s.yaml readable across restarts — a bare `chmod 644`
# gets reset to 0600 every time k3s restarts.
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/config.yaml >/dev/null <<'YAML'
disable:
  - traefik
  - servicelb
write-kubeconfig-mode: "0644"
# Reclaim the containerd image store early — the box fills with SHA-tagged images
# from every deploy, and the 85% default fires too late. (Idempotent re-tune later:
# deploy/setup-k3s.sh, which writes a config.yaml.d drop-in and restarts k3s.)
kubelet-arg:
  - "image-gc-high-threshold=70"
  - "image-gc-low-threshold=55"
YAML
curl -sfL https://get.k3s.io | sh -
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
# api-rs also requires the same key Surface already has (not seeded by bootstrap):
CAPTURE_KEY=$(sed -n 's/^ARTIFACT_CAPTURE_API_KEY=//p' ~/atrium/surface/deploy/.env | tail -n 1)
test -n "$CAPTURE_KEY" || { echo 'ARTIFACT_CAPTURE_API_KEY is empty in Surface .env' >&2; exit 1; }
kubectl -n centaur patch secret centaur-infra-env --type merge \
  -p "{\"stringData\":{\"ARTIFACT_CAPTURE_API_KEY\":\"$CAPTURE_KEY\"}}"

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
> older repo-cache templates inherited the sandbox image's non-writable
> `GIT_CONFIG_GLOBAL`; current templates set a writable git config path; (c) the
> deny-by-default **NetworkPolicy** blocks the sandbox's egress to GitHub (tools
> clone) *and* `api.openai.com` (Codex, since iron-proxy is off) → `networkPolicy.enabled=false`.
> The bootstrap `--set` flags above clear the image and NetworkPolicy blockers;
> current committed box deploys use `deploy/values.box.yaml`.

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
#   services:
#     server:
#       environment: { ATRIUM_SERVER_PUBLICATION_HOST: 10.42.0.1 }
#       ports: !override [ "10.42.0.1:3001:3001" ]
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

> **Boot error — `artifact capture is not authenticated`.** In production, Surface
> now refuses to boot with an empty or missing `ARTIFACT_CAPTURE_API_KEY` and says:
> “artifact capture is not authenticated — set `ARTIFACT_CAPTURE_API_KEY` on both
> the Surface and Centaur.” Phase 3 generates the Surface value and Phase 5 copies
> it into Centaur. If an older `.env` hits this error, copy Centaur's value into it:
> ```sh
> KEY=$(kubectl -n centaur get secret centaur-infra-env -o jsonpath='{.data.ARTIFACT_CAPTURE_API_KEY}' | base64 -d)
> cd ~/atrium/surface/deploy
> if grep -q '^ARTIFACT_CAPTURE_API_KEY=' .env; then
>   sed -i "s/^ARTIFACT_CAPTURE_API_KEY=.*/ARTIFACT_CAPTURE_API_KEY=$KEY/" .env
> else
>   echo "ARTIFACT_CAPTURE_API_KEY=$KEY" >> .env
> fi
> sudo docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml up -d server
> ```
> Confirm in `kubectl logs -n centaur <node-sync-pod>`: requests should be 200 (a
> `404` for a thread key you created directly in Centaur is fine — only real
> Atrium-spawned sessions exist in the surface DB), **never 401**.

> Note: `infra/values.local.yaml` deliberately has no `nodeSync.atriumBaseUrl` or
> `nodeSync.atriumEgress` default because those addresses are topology-specific.
> The `--set` above is therefore required for this k3s+compose topology.
> NetworkPolicy stays off so node-sync can reach `10.42.0.1`.

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
  `deploy/redeploy.sh` also prunes build cache + old SHA-tagged image copies after
  every successful deploy, so this daemon cap is the backstop, not the only defense.
- **Bound the k3s image store.** `deploy/setup-k3s.sh` tunes kubelet image GC
  (start at 70% disk, reclaim to 55%) via a `config.yaml.d` drop-in — kubelet then
  evicts unused images on its own. ⚠️ restarts k3s once (running pods survive). It's a
  no-op re-run. The **biggest** consumer is image sprawl, not app data: three stores
  accumulate SHA-tagged copies (docker build host, k3s containerd, the local registry)
  — a full sweep once reclaimed ~95 GB.
- **Bound the local registry** (10 GB range; the *smallest* of the three stores).
  Uses **`registry:3`** (CNCF distribution v3) whose `garbage-collect` correctly follows
  OCI image-index → blob references. ⚠️ **`registry:2`'s did not** — it deletes blobs for
  *in-use* images and corrupts the tags (verified the hard way: a sweep took the live
  registry to a broken 5 MB and it had to be rebuilt), which is why v3 is required. A
  POC (`registry:3`, two OCI-index images, delete one tag, `garbage-collect
  --delete-untagged`) confirmed the kept image still pulls. `deploy/setup-registry.sh`
  provisions v3 + `REGISTRY_STORAGE_DELETE_ENABLED=true` (v3 reads the v2 on-disk layout,
  so upgrading is just recreating the container on the same volume). `redeploy.sh` then
  runs `registry-gc.sh` after every deploy (alongside the docker + k3s prune), so the
  registry self-bounds with **no cron** — it keeps in-use + Sandbox-CR-pinned + the last
  N deploy commits, sweeps the rest, and re-verifies every in-use image still resolves
  afterward (failing loudly if a wrong registry version ever regresses this). If the
  registry is somehow corrupted, recover by recreating it on a fresh volume and re-pushing Docker `:latest`:
  recover by recreating it on a fresh volume and re-pushing Docker `:latest`:
  ```sh
  sudo docker rm -f registry && sudo docker volume create atrium-registry
  sudo docker run -d --restart=always -p 127.0.0.1:5000:5000 --name registry \
    -e REGISTRY_STORAGE_DELETE_ENABLED=true -v atrium-registry:/var/lib/registry registry:3
  SHA=$(cat ~/atrium-deploy/last-good-centaur-sha)
  for i in api-rs iron-proxy agent node-sync console; do
    sudo docker tag centaur-$i:latest localhost:5000/library/centaur-$i:$SHA
    sudo docker push localhost:5000/library/centaur-$i:$SHA; done
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
- **Local registry (`deploy/setup-registry.sh`):** stands up `registry:2` on
  `localhost:5000` + a k3s **HTTP mirror for `localhost:5000`** (docker.io untouched),
  so Centaur runs SHA-tagged registry images. ⚠️ restarts k3s once (all pods bounce).
- **`deploy/redeploy.sh [surface|centaur|all]`** is the committed one-command form of
  this whole loop — content-aware (rebuilds only changed images), pushes to the
  registry, rolls the pods, health-gated, with auto-rollback. It's also what CD runs
  (below). See [`deploy/README.md`](../deploy/README.md).

> An agent editing the platform's own source runs in an **isolated sandbox** — its
> changes land in the CAS ledger, not `~/atrium`. To rebuild from agent edits, pull them
> into the host source first (git/PR), then run a loop above.

## Continuous deployment (promote → box)

The committed [`deploy/`](../deploy/) tooling turns the loop above into a GitHub-driven
pipeline. `master` is the integration branch; you **promote to ship**:

```sh
git push origin master:deploy        # or merge a PR into `deploy`
```

A push to `deploy` (path-filtered to `surface/`,`centaur/`,`infra/`,`deploy/`) runs
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) on a **self-hosted
runner on the box**, which syncs `~/atrium` to `origin/deploy` and runs
`deploy/redeploy.sh all` — content-aware rebuild → registry push → health-gated
rollout → **auto-rollback** on failure. Deploys are serial and never cancel a running
one; logs + status live in the repo's **Actions** tab. Manual trigger:
`gh workflow run deploy.yml --ref deploy`.

### One-time CD setup on the box
```sh
# 1) registry + k3s HTTP mirror (⚠️ restarts k3s once — all pods bounce; do it quietly)
~/atrium/deploy/setup-registry.sh

# 2) self-hosted runner. Registration token (run where gh is authed):
#    gh api -X POST /repos/<owner>/<repo>/actions/runners/registration-token -q .token
mkdir -p ~/actions-runner && cd ~/actions-runner
VER=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed s/^v//)
curl -fsSL -o r.tgz "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
tar xzf r.tgz && sudo ./bin/installdependencies.sh
./config.sh --url https://github.com/<owner>/<repo> --token <TOKEN> --name atrium-box --labels atrium-box --unattended
sudo ./svc.sh install ubuntu && sudo ./svc.sh start
```
The runner runs as `ubuntu` (docker + kubectl + passwordless sudo). The box's `~/atrium`
must be a real clone (`git remote add origin https://github.com/<owner>/<repo>.git`); the
workflow's first sync is conversion-safe if it started as a bare `git init`.

### Cost & rollback
First deploy ≈ 20 min (baselines every image at the new SHA); after that, deploys
rebuild **only what changed** — a no-op deploy is ~15 s. State lives in
`~/atrium-deploy/{last-deployed-sha,last-good-centaur-sha}`. On a failed health check
`redeploy.sh` auto-rolls-back (surface: re-tag the previous image; Centaur: re-deploy
the last-good SHA) — verified end-to-end with a deliberately crashing build.
