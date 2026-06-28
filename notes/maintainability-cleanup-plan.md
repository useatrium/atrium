# Maintainability cleanup plan

This plan turns the high-level repo review into a staged cleanup track. The goal
is not to redesign Atrium; it is to make the current system easier to navigate,
review, and change without weakening the Atrium/Centaur split.

## Current shape

Atrium ships as two coupled parts:

- `surface/` is the TypeScript product workspace: server, web, desktop, mobile,
  shared client/state package, Centaur client, MCP, deploy config, and e2e.
- `centaur/` is the vendored runtime fork: Rust API/control plane, sandbox and
  harness code, node-sync daemon, Helm chart, and Centaur-owned packages.

The architectural boundary is sound: Atrium owns durable collaboration state and
the product experience; Centaur owns sandboxed agent execution. The main
maintainability issue is not that the boundary is wrong, but that several files
and docs still reflect earlier phases while the product has grown around them.

## Naming note: is `surface/` weird?

Somewhat, but not fatally.

It is normal in this repo for backend code to live under `surface/` because
`surface/` means "the Atrium product surface" rather than "frontend UI." It is
the pnpm workspace root for everything the user-facing product needs: server,
web, mobile, desktop, shared protocol/state, MCP, and deployment wrappers.

The awkward part is semantic drift. `surface/server` is clearly backend, and
`surface/centaur-client` is an integration package, so a new contributor may
read `surface/` as "frontend" and get confused. Renaming it to `atrium/`,
`product/`, or `app/` would be clearer in a greenfield repo, but it is a large
mechanical move with many paths, docs, workflows, Docker files, and local habits
attached.

Recommendation: do not rename `surface/` now. Instead, make the meaning explicit
in docs and package names:

- `surface/` = Atrium product workspace, not frontend-only code.
- `surface/server` = Atrium backend.
- `surface/web`, `surface/mobile`, `surface/desktop` = clients.
- `surface/shared` = product protocol and client state shared by clients.
- `surface/centaur-client` = Atrium's typed client/reducer for Centaur streams.

Revisit a directory rename only after the codebase is calmer and CI/docs are
already consistent.

## Phase 0: repo map and doc truth

Goal: make the first hour in the repo accurate.

Tasks:

- Update `AGENTS.md`: Centaur CI is now wired in root workflows, so remove the
  stale "not yet wired" warning and point to `.github/workflows/centaur-ci.yml`.
- Update `surface/README.md`: stop describing the workspace as only "Places /
  Phase 1"; describe the current packages and current validation commands.
- Add a short "where code lives" table to `surface/README.md` covering server,
  web, desktop, mobile, shared, centaur-client, mcp, e2e.
- Document that `surface/` is the Atrium product workspace, not frontend-only
  code.
- Keep Centaur-fork-specific docs in `centaur/ATRIUM_FORK.md`, not upstream-owned
  Centaur docs.

Validation:

- Docs-only review.
- Confirm links and commands still match `surface/package.json` and root
  workflows.

Risk: low.

## Phase 1: toolchain and hygiene baselines

Status: partially complete as of the current `master` baseline.

Goal: reduce upgrade churn and accidental inconsistency before moving code.

Done:

- `surface/tsconfig.base.json` exists for common strict TypeScript defaults.
- Server, web, shared, e2e, mcp, and centaur-client extend the base config.
- Expo and Electron remain explicit exceptions.
- `surface/package.json` wires `check:migrations`.
- `surface/server/scripts/check-migration-filenames.mjs` enforces migration
  filename format, rejects new duplicate numeric prefixes, and documents the
  historical duplicate groups that are already allowed.

Remaining tasks:

- Decide whether to use pnpm catalogs or root-level overrides for common dev
  tools: `typescript`, `vitest`, `@types/node`, `jsdom`, Testing Library, Vite.
- Align easy package-version drift where there is no platform reason for
  divergence.
- Add/verify ignore rules for generated local artifacts: `dist`, `out`,
  `.expo`, Playwright output, iOS build output. Keep Electron packaging assets
  under `surface/desktop/build` tracked.

Validation:

- `cd surface && pnpm lint`
- `cd surface && pnpm -r typecheck`
- `cd surface && pnpm --filter @atrium/centaur-client build`
- `cd surface && pnpm --filter '!atrium-surface' -r test`

Risk: low to medium. TypeScript config changes can surface latent issues, so
keep this phase separate from route/component movement.

## Phase 2: server composition and route decomposition

Status: complete as of the current `master` baseline.

Goal: shrink `surface/server/src/app.ts` without changing behavior.

Current state:

- `surface/server/src/app.ts` is now a small composition root.
- Cross-cutting app setup lives in focused `app-*.ts` modules.
- Route registration is centralized in `surface/server/src/app-routes.ts`.
- Domain route handlers live under `surface/server/src/routes/`.

Keep this shape:

- Keep `buildApp()` in `app.ts` as the composition root.
- Keep app-level dependency construction in `app-services.ts` and related
  install helpers.
- Keep route modules domain-oriented.
- Extract server helpers only when a route module repeatedly reimplements the
  same parsing, authorization, or projection logic.

Remaining server hotspots are deeper than route registration:

- `surface/server/src/session-runs.ts`
- `surface/server/src/events.ts`
- `surface/server/src/session-records.ts`
- `surface/server/src/agent-profiles.ts`
- `surface/server/src/artifact-ledger.ts`

Do not split these just for line count. They should move only when the next
change exposes a clear subdomain boundary, because they contain durable product
and projection behavior.

Validation:

- Preserve the full surface check.
- For future server splits, run the affected server tests plus
  `cd surface && pnpm --filter @atrium/server test`.

Risk: low for preserving the current shape; medium for deeper domain splits.

## Phase 3: web shell decomposition

Status: next recommended implementation phase.

Goal: make the main chat shell readable and easier to change.

Current hotspot:

- `surface/web/src/Chat.tsx` is over 2.3k lines and owns app hydration, channel
  selection, read cursors, websocket handling, op queue setup, drafts, sessions,
  provider dialogs, and call UI.

Approach:

- Extract hooks before extracting visual components:
  - `useBootHydration`
  - `useChannelSelection`
  - `useReadCursors`
  - `useQueuedOps`
  - `useDraftState`
  - `useSessionPaneState`
  - `useProviderCredentialDialogs`
- Keep `Chat.tsx` as the shell that wires hooks and renders layout.
- Do not redesign UI or state shape in this phase.

Validation:

- Existing web tests.
- E2e chat and session specs.
- Manual smoke for login, channel switch, thread open, session open, provider
  dialog, and call banner if call env is configured.

Risk: medium. Hook extraction can accidentally change effect timing.

## Phase 4: session pane decomposition

Status: next recommended implementation phase after the first `Chat.tsx` hook
extractions.

Goal: isolate session collaboration concepts from transcript rendering.

Current hotspot:

- `surface/web/src/sessions/SessionPane.tsx` is over 2.1k lines and mixes stream
  projection, driver-seat logic, suggestions, HITL questions, transcript
  rendering, work drawer state, provider auth UI, and terminal-state behavior.

Approach:

- Extract presentational pieces first:
  - `SessionPaneHeader`
  - `SessionStatusBar`
  - `SessionSeatControls`
  - `SessionQuestionPanel`
  - `SessionSuggestionComposer`
  - `TranscriptList`
  - `TranscriptItem`
  - `ProviderAuthRequiredCallout`
- Extract derived-state hooks second:
  - `useSessionDisplayStatus`
  - `useSessionWorkDrawer`
  - `useDriverSeatState`
  - `useQuestionState`
- Keep the Centaur stream reducer in `@atrium/centaur-client`; do not fork
  stream interpretation into the UI.

Validation:

- Existing `sessionPane`, `sessionStream`, work drawer, conflicts, artifacts,
  plan panel, and reasoning block tests.
- One manual long transcript scroll check.

Risk: medium. Most bugs here would be subtle UI state regressions.

## Phase 5: protocol/type ownership cleanup

Goal: make wire contracts obviously owned by one package.

Tasks:

- Treat `@atrium/surface-client` as owner of Atrium product wire/session types
  consumed by web and mobile.
- Treat `@atrium/centaur-client` as owner of Centaur stream event types and
  reducer-derived stream state.
- Keep server DB row types private to server modules.
- Replace server-side duplicated session DTO interfaces where practical with
  shared exported wire types.
- Add type-level tests or compile tests for important cross-package contracts.
- Keep web-only glue, like Centaur execution status to Atrium session status, in
  a small adapter module.

Validation:

- Full surface typecheck.
- Existing session fold/reducer tests.

Risk: medium to high if done too broadly. Make this incremental.

## Phase 6: dev mock and fixture quarantine

Goal: keep useful mock sessions without making production flow harder to read.

Tasks:

- Move `surface/web/src/sessions/devMock.ts` behind an explicit dev/test module
  boundary.
- Rename imports so production readers can see the mock is env-gated.
- Consider moving canned Centaur frames into fixtures shared with
  `@atrium/centaur-client` tests.
- Add a short comment in the dev entry point explaining `VITE_SESSIONS_MOCK`.

Validation:

- Web tests that rely on mock mode.
- Manual `VITE_SESSIONS_MOCK=1` smoke.
- Manual normal dev server smoke without mock mode.

Risk: low to medium.

## Phase 7: optional directory rename decision

Goal: decide whether `surface/` should ever be renamed.

Default recommendation: defer.

A rename may be worth it if:

- New contributors repeatedly misunderstand `surface/` as frontend-only.
- Most path-sensitive cleanup above is already done.
- CI, Docker, docs, deploy, desktop packaging, and local runbooks are stable.

Candidate names:

- `atrium/`: clearest product name, but slightly redundant with repo name.
- `product/`: clear contrast with `centaur/`, but less idiomatic.
- `app/`: familiar, but can still sound frontend-only.

Do not rename as part of the cleanup phases above. It would create large churn
without improving runtime behavior.

## Suggested PR sequence

Completed:

1. Docs truth pass: AGENTS, surface README, repo map.
2. Server composition and route split.

Current recommended sequence:

1. Keep this plan current with the post-server-refactor architecture.
2. Web `Chat.tsx` hook extraction.
3. `SessionPane.tsx` presentational extraction.
4. Dev mock quarantine.
5. Mobile chat provider/screen decomposition.
6. Remaining toolchain/package-version policy.
7. Remaining hygiene guardrails.
8. Protocol/type ownership cleanup.
9. Optional deeper server domain splits when a concrete change exposes the
   boundary.

Each PR should be intentionally boring: small surface area, existing tests, and
no unrelated product changes.
