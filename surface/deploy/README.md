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

Critical: `S3_ENDPOINT` is embedded into presigned file upload/download URLs. Set it to a URL the phone can reach. `http://minio:9000` works inside Docker but fails on the phone.

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

The mobile app server URL is:

```text
https://atrium.example.com
```

Start:

```sh
cd surface/deploy
docker compose -f docker-compose.prod.yml --profile caddy up -d --build
```

For file uploads on a VPS, expose MinIO through a separate TLS name such as `minio.example.com`, or add a deliberate Caddy proxy for a storage path and set `S3_ENDPOINT` to that public HTTPS URL. Do not leave `S3_ENDPOINT` pointing at Docker-only hostnames.

## Production Voice Calls

Calls add a direct LiveKit path beside the app path:

- app and file hosts stay behind Cloudflare Tunnel and local Caddy
- LiveKit runs on the OVH host with host networking
- LiveKit/TURN hostnames are DNS-only records pointing at the OVH public IP
- public `443/tcp` belongs to LiveKit TURN/TLS, not the app Caddy tunnel

Use separate names so the routing boundary stays obvious:

| Hostname | DNS / route | Purpose |
|---|---|---|
| `atrium.example.com` | Cloudflare Tunnel route | App/API/WebSocket |
| `atrium-files.example.com` | Cloudflare Tunnel route, no Access policy | MinIO presigned uploads/downloads |
| `livekit.example.com` | DNS-only A/AAAA to the OVH IP | LiveKit signaling endpoint in `LIVEKIT_URL` |
| `turn.example.com` | DNS-only A/AAAA to the OVH IP | Embedded TURN/TLS domain in `livekit.yaml` |

Open these inbound ports on the OVH firewall/security group for LiveKit:

- `443/tcp` for TURN/TLS
- `7881/tcp` for ICE TCP fallback
- `3478/udp` for TURN/UDP and STUN
- `50000-60000/udp` for LiveKit media
- `80/tcp` only if the chosen certificate flow needs HTTP-01/standalone ACME for the LiveKit/TURN certificates

Do not proxy LiveKit media or TURN through the HTTP Caddy tunnel. Caddy's app
profile can proxy Atrium HTTP and WebSockets, but it cannot proxy LiveKit UDP
media, ICE TCP, or TURN/TLS. In the tunnel topology, keep app Caddy bound to
loopback and reserve public `443` for LiveKit TURN/TLS.

Required `.env` values:

```sh
LIVEKIT_URL=wss://livekit.example.com
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

Use the same `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` for the server and the
`livekit` compose profile. The compose file injects them into LiveKit as
`LIVEKIT_KEYS`, so token signing and verification share one source of truth.

For APNs, production builds, TestFlight builds, App Store builds, and EAS
internal/ad-hoc builds use production APNs tokens. Leave `APNS_SANDBOX=0` unless
the app was signed with a true development provisioning profile.

Smoke checklist:

- `curl -s https://atrium.example.com/auth/methods | jq '.calls == true'`
- a two-browser web call can start, ring, join, and pass audio
- an iOS device with the app killed rings through APNs
- a participant can reload and rejoin the active call

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

Presigned URLs fail on mobile: verify `S3_ENDPOINT` opens from the phone. On Tailscale, use the Mac's Tailscale IP or MagicDNS name plus `:9000`. On a VPS, use a public HTTPS MinIO endpoint or path proxy.

WebSocket connection fails: make sure traffic reaches Caddy, then check `docker compose logs caddy server`. The Caddyfile proxies `/ws` to the server and Caddy handles WebSocket upgrades automatically.

Server is unhealthy: read `docker compose logs server`. Startup includes migration logs and will fail if `DATABASE_URL`, `SESSION_SECRET`, or S3 credentials are wrong.

Migrations appear stuck: the server uses a Postgres advisory lock. Confirm only one deployment is booting, then inspect `docker compose logs server db`.

Frontend shows 404 on refresh: Caddy's `try_files {path} /index.html` is the SPA fallback. Confirm `surface/web/dist/index.html` exists and the `caddy` service has the bind mount.

## Port exposure

Postgres always binds to `127.0.0.1` on the host (`DB_BIND_HOST`). The API
server and MinIO bind to `BIND_HOST` (default `127.0.0.1`). Keep that default on
an internet-facing VPS so only Caddy (80/443) is reachable; set
`BIND_HOST=0.0.0.0` only for a private tailnet-style deployment.
