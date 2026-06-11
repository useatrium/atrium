# Atrium Surface Production Deployment

This package runs the Atrium surface stack with Postgres, MinIO, the Fastify API server, and optional Caddy for the built web SPA.

The server image uses `node:24-alpine` to match the repo's current Node 24 type/runtime target. It compiles the TypeScript server during the Docker build, builds the local `@atrium/centaur-client` package first, then runs `node dist/index.js` as a non-root user. Migrations run automatically when the server boots.

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

## Scenario A: Always-On Mac Behind Tailscale

Use plain HTTP on the tailnet. In `.env`:

```sh
SITE_ADDRESS=:80
HTTP_HOST_PORT=80
S3_ENDPOINT=http://<mac-tailscale-ip-or-magicdns-name>:9000
```

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

## Chat-Only Deployments

Centaur is optional at boot. Leave `CENTAUR_API_KEY` empty and keep `CENTAUR_BASE_URL` at its default if you only need chat. Agent session spawning will be unavailable until Centaur is reachable and configured.

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
