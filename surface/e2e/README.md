# Atrium Surface E2E

Playwright coverage for the Atrium surface web client.

## Prerequisites

- Start the docker services from `surface/` so Postgres is available at `localhost:5433`.
- Stop any manually running surface dev stack before running e2e.
- The suite defaults to isolated ports `3101` for the API and `5273` for Vite. Override with `E2E_SERVER_PORT` and `E2E_WEB_PORT` if needed.

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

## Database

The suite uses a dedicated `atrium_e2e` database, created by the Playwright server preflight through the admin connection `postgres://atrium:atrium@localhost:5433/atrium`. The preflight truncates the e2e database with `RESTART IDENTITY CASCADE` before the API server boots; the API server then runs migrations and bootstraps the default workspace and `#general`.
