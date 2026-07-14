# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV CI=true
RUN corepack enable

FROM base AS server_deps
COPY surface/package.json surface/pnpm-lock.yaml surface/pnpm-workspace.yaml surface/tsconfig.base.json ./surface/
COPY surface/patches ./surface/patches
COPY surface/server/package.json ./surface/server/package.json
COPY surface/shared/package.json ./surface/shared/package.json
COPY surface/centaur-client/package.json ./surface/centaur-client/package.json
RUN cd surface && pnpm install --frozen-lockfile --ignore-scripts --filter @atrium/server...

FROM server_deps AS server_build
COPY surface/server ./surface/server
COPY surface/shared ./surface/shared
COPY surface/centaur-client ./surface/centaur-client
RUN cd surface/server && pnpm exec esbuild src/index.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node24 \
  --sourcemap \
  --outfile=dist/index.js \
  --banner:js='import { createRequire as __createRequire } from "module"; import { fileURLToPath as __fileURLToPath } from "url"; import { dirname as __pathDirname } from "path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);' \
  --external:fastify \
  --external:@fastify/* \
  --external:pg \
  --external:@aws-sdk/* \
  --external:sharp \
  --external:pdf-to-img
RUN cd surface && pnpm --filter @atrium/server deploy --prod --legacy --config.allow-unused-patches=true /out

FROM base AS web_deps
COPY surface/package.json surface/pnpm-lock.yaml surface/pnpm-workspace.yaml surface/tsconfig.base.json ./surface/
COPY surface/patches ./surface/patches
COPY surface/web/package.json ./surface/web/package.json
COPY surface/shared/package.json ./surface/shared/package.json
COPY surface/centaur-client/package.json ./surface/centaur-client/package.json
RUN cd surface && pnpm install --frozen-lockfile --ignore-scripts --filter @atrium/web...

FROM web_deps AS web_build
COPY surface/web ./surface/web
COPY surface/shared ./surface/shared
COPY surface/centaur-client ./surface/centaur-client
COPY surface/test-support ./surface/test-support
RUN cd surface && pnpm --filter @atrium/web build:ci

FROM node:24-alpine AS runtime
WORKDIR /app/surface/server
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3001 \
    APPS_HOST=127.0.0.1 \
    APPS_PORT=3002

RUN apk add --no-cache caddy

COPY --from=server_build /out ./
COPY --from=server_build /app/surface/server/dist ./dist
COPY --from=server_build /app/surface/server/migrations ./migrations
COPY --from=web_build /app/surface/web/dist /srv
COPY deploy/preview/fly/.generated/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["sh", "-c", "node dist/index.js & exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
