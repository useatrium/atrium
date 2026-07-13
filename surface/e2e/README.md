# Atrium Surface E2E

Playwright coverage for the Atrium surface web client.

## Prerequisites

- Start the docker services from `surface/` so Postgres is available at `localhost:5433`.
- Stop any manually running surface dev stack before running e2e.

### Concurrent runs across worktrees

Ports **and the database name are derived from the checkout's path**, so several
worktrees can run e2e at the same time without colliding. A run in
`~/Code/atrium` and a run in `.worktrees/foo` get different ports and different
databases.

This matters because `db-reset.mjs` TRUNCATEs every table it owns. When the
ports and the database were fixed and shared, a second run would either abort on
`assertPortFree` or wipe the first run's data mid-test — which surfaced as
"flaky" failures scattered across unrelated features (unread badges, threads,
read-sync) that were really just rows disappearing underneath the tests.

Consequences worth knowing:

- **Don't `kill -9` whatever holds an e2e port** without checking whose it is.
  On a box running several worktrees it is probably another session's live run.
  `lsof -tiTCP:<port> -sTCP:LISTEN` then `ps -p <pid> -o command=` tells you the
  checkout it belongs to.
- Overrides: `E2E_SERVER_PORT`, `E2E_WEB_PORT`, `E2E_CENTAUR_PORT`,
  `E2E_DATABASE_URL`. Two checkouts can in principle hash to the same port slot
  (100 of them); that shows up as a loud `assertPortFree` error, and
  `E2E_PORT_OFFSET=<n>` breaks the tie.
- `E2E_EXPECT_TIMEOUT` overrides the assertion budget (default 20s, same locally
  and on CI). Don't hand-tune per-assertion timeouts below it — that is what
  accumulated 34 ad-hoc bumps and quietly tightened CI below its own base.

## Run

```sh
cd surface
pnpm install
pnpm exec playwright install chromium
pnpm --filter @atrium/e2e e2e
```

The workspace root also exposes:

```sh
pnpm e2e
```

## Web serving mode

Local runs serve the web client from the Vite dev server. CI serves a static
development-mode build (`vite build --mode development` + `vite preview`)
instead: the dev server's on-demand transforms starve 2-vCPU runners and made
the first-scheduled spec chronically blow its 60s timeout. Force either mode
with `E2E_WEB_SERVE=built` or `E2E_WEB_SERVE=dev`. The build must stay in
development mode — the markup specs drive the ProseMirror editor through a
DEV-only `__atriumMarkupEditorView` hook.

## Database

The suite uses a dedicated `atrium_e2e` database, created by the Playwright server preflight through the admin connection `postgres://atrium:atrium@localhost:5433/atrium`. The preflight truncates the e2e database with `RESTART IDENTITY CASCADE` before the API server boots; the API server then runs migrations and bootstraps the default workspace and `#general`.
