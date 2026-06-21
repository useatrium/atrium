#!/usr/bin/env bash
# launch.sh — stand up an ISOLATED Atrium instance for an sj-audit run.
#
# Isolation (so it never collides with the dev instance on :3001 or other agents):
#   - a fresh git worktree cut from `master`
#   - a fresh Postgres database on the shared dev Postgres (docker, :5433)
#   - free, probed server + web ports
#   - the dev sessions mock enabled (VITE_SESSIONS_MOCK=1) so agent surfaces are exercisable
#   - EMAIL_MODE=log + AUTH_DEV_CODES=1 so the dev-login path works without a mailer
#
# Contract: prints `BASE_URL=<web-url>` on success; also `WORKTREE=` and `CLEANUP_PID=`
# so the skill can tear down. Logs go to $SJ_RUN. See reference/hook-contract.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="${SJ_RUN:-/tmp/sj-audit-atrium}"
mkdir -p "$RUN"
ID="$(basename "$RUN" | tr -cd 'a-z0-9')"; ID="${ID:-run}"
log(){ echo "[launch] $*" >&2; }

free_port(){ python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'; }

# --- shared dev Postgres (idempotent) ---
COMPOSE="$REPO/surface/docker-compose.yml"
log "ensuring dev Postgres is up (docker compose)"
docker compose -f "$COMPOSE" up -d postgres >/dev/null 2>&1 || log "WARN: could not 'compose up postgres' (assuming it's already running)"

PGUSER=atrium; PGPASS=atrium; PGHOST=localhost; PGPORT=5433
DB="atrium_sj_${ID}"
psql_exec(){ docker compose -f "$COMPOSE" exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 "$@"; }
log "creating fresh database $DB"
psql_exec -c "DROP DATABASE IF EXISTS ${DB};" >/dev/null 2>&1 || true
psql_exec -c "CREATE DATABASE ${DB};" >/dev/null
DATABASE_URL="postgres://${PGUSER}:${PGPASS}@${PGHOST}:${PGPORT}/${DB}"

# --- fresh worktree from master ---
WORKTREE="${REPO}-sjwt-${ID}"
if [ ! -d "$WORKTREE" ]; then
  log "creating worktree $WORKTREE from master"
  git -C "$REPO" worktree add -f --detach "$WORKTREE" master >/dev/null 2>&1
fi
SURF="$WORKTREE/surface"

# --- deps (pnpm store is content-addressed, so this is fast on a warm machine) ---
log "installing deps (pnpm) — may take a bit on a cold store"
( cd "$SURF" && pnpm install --prefer-offline >"$RUN/pnpm-install.log" 2>&1 ) || { log "pnpm install failed; see $RUN/pnpm-install.log"; exit 1; }

# --- migrate the fresh DB ---
log "running migrations against $DB"
( cd "$SURF" && DATABASE_URL="$DATABASE_URL" pnpm --filter @atrium/server migrate >"$RUN/migrate.log" 2>&1 ) || { log "migrate failed; see $RUN/migrate.log"; exit 1; }

# --- pick ports ---
SERVER_PORT="$(free_port)"; WEB_PORT="$(free_port)"
log "server :$SERVER_PORT  web :$WEB_PORT"

# --- start server ---
( cd "$SURF" && \
  PORT="$SERVER_PORT" HOST=127.0.0.1 DATABASE_URL="$DATABASE_URL" \
  EMAIL_MODE=log AUTH_DEV_CODES=1 \
  pnpm --filter @atrium/server start >"$RUN/server.log" 2>&1 ) &
SERVER_PID=$!

# --- start web (vite) pointed at our isolated server, with the sessions mock on ---
( cd "$SURF" && \
  ATRIUM_API_TARGET="http://localhost:${SERVER_PORT}" VITE_SESSIONS_MOCK=1 \
  pnpm --filter @atrium/web exec vite --port "$WEB_PORT" --strictPort >"$RUN/web.log" 2>&1 ) &
WEB_PID=$!

# --- wait for web to answer ---
BASE_URL="http://localhost:${WEB_PORT}"
log "waiting for $BASE_URL"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "$BASE_URL" 2>/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then log "server died; see $RUN/server.log"; exit 1; fi
  sleep 1
done

echo "BASE_URL=${BASE_URL}"
echo "WORKTREE=${WORKTREE}"
echo "CLEANUP_PID=${SERVER_PID} ${WEB_PID}"
echo "DATABASE=${DB}"
log "up: web=$BASE_URL server=:$SERVER_PORT db=$DB worktree=$WORKTREE"
