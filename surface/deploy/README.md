# Atrium Surface Self-Hosting

This package runs the Atrium surface stack with Postgres, MinIO, the Fastify API server, and optional Caddy for the built web SPA.

The server image uses `node:24-alpine` to match the repo's current Node 24 type/runtime target. It installs the filtered surface workspace, bundles the server with esbuild (workspace `@atrium/*` packages export TypeScript source, so they are compiled into the artifact; real dependencies come from `pnpm deploy --prod`), then runs `node dist/index.js` as a non-root user. Migrations run automatically when the server boots.

## Build The Web App

From the repo root:

```sh
corepack enable
cd surface
pnpm install --frozen-lockfile
pnpm --filter @atrium/web build
```

Caddy serves `surface/web/dist` through a read-only bind mount. Rebuild the web app after frontend changes.

## Configure

```sh
cp surface/deploy/.env.example surface/deploy/.env
openssl rand -hex 32
openssl rand -base64 32
```

Put generated values into `DB_PASSWORD`, `MINIO_PASSWORD`, and `SESSION_SECRET`.

Critical: `S3_ENDPOINT` is embedded into presigned file upload/download URLs; server byte I/O uses `S3_INTERNAL_ENDPOINT`, which defaults to `http://minio:9000` in prod compose. Set `S3_ENDPOINT` to a URL the phone can reach.

Before exposing Atrium beyond your own machine:

- keep `AUTH_OPEN=0` unless anyone who can reach the host may create an account
- configure email-code or OAuth login
- keep `BIND_HOST=127.0.0.1` for internet-facing hosts and put Caddy/TLS in front
- set long random values for every secret in `.env`
- rotate any secret that was ever pasted into logs, notes, issues, or chat
- back up Postgres and MinIO together

## Scenario A: Always-On Mac Behind Tailscale

Use plain HTTP on the tailnet. In `.env`:

```sh
SITE_ADDRESS=:80
HTTP_HOST_PORT=80
BIND_HOST=0.0.0.0
S3_ENDPOINT=http://<mac-tailscale-ip-or-magicdns-name>:9000
```

Leave `S3_INTERNAL_ENDPOINT` unset unless the server cannot reach MinIO at the compose-internal `http://minio:9000` default.

Only use `BIND_HOST=0.0.0.0` when the host firewall or network boundary prevents
non-tailnet access to the API and MinIO ports.

If port 80 is unavailable locally, use:

```sh
HTTP_HOST_PORT=8080
SITE_ADDRESS=:80
```

Then the mobile app server URL is:

```text
http://<mac-tailscale-ip-or-magicdns-name>
```

or, with `HTTP_HOST_PORT=8080`:

```text
http://<mac-tailscale-ip-or-magicdns-name>:8080
```

Start:

```sh
cd surface/deploy
docker compose -f docker-compose.prod.yml --profile caddy up -d --build
```

MinIO's API is exposed on `MINIO_HOST_PORT` for direct phone access to presigned URLs. The MinIO console is intentionally not exposed by default.

## Scenario B: Small Linux VPS With Caddy Auto-TLS

Point DNS for `atrium.example.com` at the VPS. In `.env`:

```sh
SITE_ADDRESS=atrium.example.com
HTTP_HOST_PORT=80
HTTPS_HOST_PORT=443
S3_ENDPOINT=https://minio.example.com
```

Leave `S3_INTERNAL_ENDPOINT` unset unless the server needs a different private MinIO URL than the compose-internal `http://minio:9000` default.

The mobile app server URL is:

```text
https://atrium.example.com
```

Start:

```sh
cd surface/deploy
docker compose -f docker-compose.prod.yml --profile caddy up -d --build
```

For file uploads on a VPS, expose MinIO through a separate TLS name such as `minio.example.com`, or add a deliberate Caddy proxy for a storage path and set public `S3_ENDPOINT` to that HTTPS URL. Keep server byte I/O on private `S3_INTERNAL_ENDPOINT` where possible.

## Production Voice Calls

Calls use three routes. Keep them separate:

- app and file hosts stay behind Cloudflare Tunnel and local Caddy
- LiveKit signaling goes through Cloudflare Tunnel to `localhost:7880`
- LiveKit media, ICE TCP fallback, and TURN run direct from the host network
- public `443/tcp` belongs to LiveKit TURN/TLS, not the app Caddy tunnel

Use separate names so the routing boundary stays obvious:

| Hostname | DNS / route | Purpose |
|---|---|---|
| `atrium.example.com` | Cloudflare Tunnel route | App/API/WebSocket |
| `atrium-files.example.com` | Cloudflare Tunnel route, no Access policy | Public `S3_ENDPOINT` for MinIO presigned uploads/downloads |
| `livekit.example.com` | Cloudflare Tunnel route to `http://localhost:7880` | LiveKit signaling endpoint in `LIVEKIT_URL` |
| `turn.example.com` | DNS-only A/AAAA to the OVH IP | TURN/TLS domain from `LIVEKIT_TURN_DOMAIN` |

On the OVH tunnel box, use the local `docker-compose.tunnel.yml` override so
Caddy binds only `127.0.0.1:80` for cloudflared. That leaves public `443/tcp`
available for LiveKit TURN/TLS.

Open these inbound ports on the OVH firewall/security group for LiveKit:

- `443/tcp` for TURN/TLS
- `7881/tcp` for ICE TCP fallback
- `3478/udp` for TURN/UDP and STUN
- `50000-60000/udp` for LiveKit media
- `80/tcp` only if the chosen certificate flow needs HTTP-01/standalone ACME for the TURN certificate

Do not proxy LiveKit media or TURN through the HTTP Caddy tunnel. Caddy's app
profile can proxy Atrium HTTP and WebSockets, and cloudflared can carry the
LiveKit signaling WebSocket, but neither path handles LiveKit UDP media, ICE TCP,
or TURN/TLS. Keep app Caddy bound to loopback and reserve public `443` for
LiveKit TURN/TLS.

For TURN/TLS, `LIVEKIT_TURN_DOMAIN` in `surface/deploy/.env` is the source of
truth. The deploy lane materializes the host-local runtime LiveKit config under
`${ATRIUM_DEPLOY_STATE_DIR:-<repo-parent>/atrium-deploy}/surface`; do not
hand-edit the committed
`surface/deploy/livekit.yaml` on the box for a production hostname. Treat that
file as the repo template.

The committed compose file already mounts certbot's live paths based on
`LIVEKIT_TURN_DOMAIN`:

- `/etc/letsencrypt/live/${LIVEKIT_TURN_DOMAIN}/fullchain.pem` to `/etc/livekit/turn.crt`
- `/etc/letsencrypt/live/${LIVEKIT_TURN_DOMAIN}/privkey.pem` to `/etc/livekit/turn.key`

Do not create a cert-specific compose override for the normal OVH topology. Set
`LIVEKIT_TURN_DOMAIN`, issue the certificate for that hostname, and let
`redeploy.sh` render the runtime config before it runs the existing `livekit`
compose profile. For manual compose runs, first export
`LIVEKIT_CONFIG_FILE="$(./prepare-livekit-config.sh)"` and use `sudo -E docker
compose ...`. Use DNS-01, or open `80/tcp` only for HTTP-01 issuance/renewal.

Required `.env` values:

```sh
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_TURN_DOMAIN=turn.example.com
LIVEKIT_API_KEY=<generated-livekit-key>
LIVEKIT_API_SECRET=<generated-livekit-secret>

APNS_TEAM_ID=<apple-team-id>
APNS_KEY_ID=<apns-key-id>
APNS_AUTH_KEY_P8=<contents-of-the-p8-key>
APNS_BUNDLE_ID=chat.atrium.app
APNS_SANDBOX=0

# Deferred until Android is being tested.
FCM_PROJECT_ID=
FCM_SERVICE_ACCOUNT_JSON=
```

`LIVEKIT_TURN_DOMAIN` is an operator value: use the same hostname for the
DNS-only TURN record, the rendered `turn.domain` in the host-local LiveKit
runtime config, and the Let's Encrypt cert path. The server reads `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.

Use the same `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` for the server and the
`livekit` compose profile. The compose file injects them into LiveKit as
`LIVEKIT_KEYS`, so token signing and verification share one source of truth.

### Call reaping webhook

Without this, a call whose participants disappear without a clean hang-up
(crash, force-quit, dropped network) stays `ringing`/`active` forever — the
server has no other way to learn the room ended. The committed `livekit.yaml`
template carries a `webhook:` block that points LiveKit at the server's
`POST /api/calls/webhook`; the server ends the call on `room_finished` /
`participant_left` and verifies each request's signature with
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`. `prepare-livekit-config.sh` substitutes
the `webhook.api_key` from `LIVEKIT_API_KEY` at render time (the same env the
`livekit` profile signs with), so signer and verifier stay in lockstep.

Because LiveKit runs on the host network, the webhook URL must point at whatever
host address the server is actually published on — and the tunnel topology
`!override`s that off loopback to `10.42.0.1:3001` (see `docker-compose.tunnel.yml`).
`redeploy.sh` derives `LIVEKIT_WEBHOOK_URL` from the same tunnel detection it
uses for the health-check URL (loopback for a plain deploy, `10.42.0.1` under
the tunnel) and `prepare-livekit-config.sh` substitutes it in, so no `.env`
value is normally needed; set `LIVEKIT_WEBHOOK_URL` in `.env` only to override
(e.g. a non-default `SERVER_HOST_PORT` or a bespoke topology). Either way it
stays host-local: no Caddy hop and no additional firewall port. Note LiveKit
reads its config only at startup, so `redeploy.sh` force-recreates the `livekit`
container whenever the rendered config changes.

The TURN renewal helper is `surface/deploy/renew-turn-cert.sh` on the box
(`~/atrium/surface/deploy/renew-turn-cert.sh` in the standard checkout). It runs
certbot renewal and restarts LiveKit when certbot's deploy hook records a
renewed certificate. Install or refresh the systemd timer with
`surface/deploy/install-turn-renewal.sh`; the timer calls the repo-managed
renewal script through `/usr/local/sbin/atrium-renew-turn-cert`.

The server image uses `pnpm deploy --prod` during the Docker build. The pnpm
store for deploy/build state belongs outside the checked-out repo, under the
explicit host deploy state area, not in `~/atrium`. The renewal systemd unit
pins the same state dir so it does not fall back to root's `$HOME`.
`~/atrium/surface/.pnpm-store` should not exist on the box; if it appears,
remove the stale directory after confirming no host-local pnpm process is using
it.

For APNs, production builds, TestFlight builds, App Store builds, and EAS
internal/ad-hoc builds use production APNs tokens. Leave `APNS_SANDBOX=0` unless
the app was signed with a true development provisioning profile.

Smoke checklist:

- `curl -s https://atrium.example.com/auth/methods | jq '.calls == true'`
- a two-browser web call can start, ring, join, and pass audio
- a participant can reload and rejoin the active call
- reaping webhook: start a call, hard-close every participant tab, and within a
  few seconds `GET /api/calls/active` stops listing it (LiveKit fires
  `room_finished` → server ends the call). `docker compose logs livekit | grep
  -i webhook` should show the POST; a 401 means the api_key and
  `LIVEKIT_API_KEY` disagree.
- manual iOS smoke: an on-device build with the app killed rings through APNs

Gary/OVH note: `atrium.garybasin.com` and `atrium-files.garybasin.com` route
through the Cloudflare Tunnel, `livekit.garybasin.com` tunnels to
`localhost:7880` for signaling, and `turn.garybasin.com` is DNS-only to the OVH
IP for direct TURN/TLS and media fallback.

## Chat-Only Deployments

Centaur is optional at boot. Leave `CENTAUR_API_KEY` empty and keep `CENTAUR_BASE_URL` at its default if you only need chat. Agent session spawning will be unavailable until Centaur is reachable and configured.

## GitHub Connections

Per-user GitHub connections require Centaur console / iron-control. Configure
Surface with `IRON_CONTROL_BASE_URL`, `IRON_CONTROL_API_KEY`, and
`IRON_CONTROL_NAMESPACE`. To enable the primary GitHub App user-OAuth button,
also set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and
`GITHUB_APP_REDIRECT_URL`. To support GitHub App installation-token
connections, also set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; optionally
set `GITHUB_APP_PRIVATE_KEY_ID` and `GITHUB_PUBLIC_READ_TOKEN`. Then follow the
cutover and rollback runbook in
[`docs/github-connections-ops.md`](../../docs/github-connections-ops.md).

## Operations

Check health:

```sh
curl http://localhost:${SERVER_HOST_PORT:-3001}/healthz
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs server
```

Back up Postgres:

```sh
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U atrium atrium > atrium-$(date +%Y%m%d).sql
```

Back up MinIO data:

```sh
docker run --rm -v atrium-deploy_atrium_minio:/data:ro -v "$PWD":/backup alpine tar czf /backup/atrium-minio-$(date +%Y%m%d).tgz -C /data .
```

Restore Postgres into an empty database:

```sh
docker compose -f docker-compose.prod.yml exec -T db psql -U atrium atrium < atrium-YYYYMMDD.sql
```

## Troubleshooting

Presigned URLs fail on mobile: verify public `S3_ENDPOINT` opens from the phone. On Tailscale, use the Mac's Tailscale IP or MagicDNS name plus `:9000`; on a VPS, use a public HTTPS MinIO endpoint or path proxy. If server storage ops fail, verify `S3_INTERNAL_ENDPOINT` reaches MinIO from the server container.

WebSocket connection fails: make sure traffic reaches Caddy, then check `docker compose logs caddy server`. The Caddyfile proxies `/ws` to the server and Caddy handles WebSocket upgrades automatically.

Server is unhealthy: read `docker compose logs server`. Startup includes migration logs and will fail if `DATABASE_URL`, `SESSION_SECRET`, or S3 credentials are wrong.

Migrations appear stuck: the server uses a Postgres advisory lock. Confirm only one deployment is booting, then inspect `docker compose logs server db`.

Frontend shows 404 on refresh: Caddy's `try_files {path} /index.html` is the SPA fallback. Confirm `surface/web/dist/index.html` exists and the `caddy` service has the bind mount.

## Port exposure

Postgres always binds to `127.0.0.1` on the host (`DB_BIND_HOST`). The API
server and MinIO bind to `BIND_HOST` (default `127.0.0.1`). Keep that default on
an internet-facing VPS so only Caddy (80/443) is reachable; set
`BIND_HOST=0.0.0.0` only for a private tailnet-style deployment.
