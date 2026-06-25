# Artifact apps current implementation plan

Status: scoped from current `master` on 2026-06-25. This is the current build
plan for static artifact apps and corrects stale details in `artifact-apps-plan.md`.

## Corrections to older note

- Current migrations are through `047_agent_profiles.sql`; the apps migration
  should be next after that, not `041_apps.sql`.
- The apps origin must stream/proxy durable S3 bytes itself. Do not implement
  apps serving as `302 -> presigned S3`; the final iframe document would become
  S3-origin, relative assets would not inherit the path grant, and CSP/frame
  headers would not be reliably controlled by the apps origin.
- App publish depends on durable CAS/S3 blobs from the single-CAS hard cut. It
  should reject missing `cas_blobs.s3_key`.
- Full media extraction/search is not a prerequisite. Apps only need enough
  text/media classification to validate manifests and safe static assets.

## Scope decision

Current canonicalization maps bare `apps/foo/...` to the active channel:

```text
shared/channels/<active-channel-id>/apps/foo/...
```

V1 should accept channel-scoped apps by default. Workspace-wide apps can be
created by explicitly publishing from:

```text
shared/global/apps/foo/...
```

Do not invent a separate top-level app namespace in v1.

## Phase 1: DB and registry

Likely files:

- `surface/server/migrations/048_apps.sql` or next available migration number
- `surface/server/src/app-registry.ts`
- `surface/server/src/artifact-ledger-gc.ts`
- `surface/server/src/artifact-path.ts` only if app path affordances are added

Tables:

- `apps`
  - `id`
  - `workspace_id`
  - `channel_id`
  - `session_id`
  - `name`
  - `root_path`
  - `entry`
  - `description`
  - `created_by`
  - `current_version`
  - `status`
  - timestamps
- `app_versions`
  - `app_id`
  - `version`
  - `rel_path`
  - frozen `artifact_id`
  - frozen `version_seq`
  - `blob_sha`
  - `mime`
  - `size_bytes`

GC:

- Add `app_versions.blob_sha` as a CAS GC root.
- A published app must remain servable even if source artifact history is later
  pruned.

Registry behavior:

- Publish in one transaction.
- Serialize per app row with `SELECT ... FOR UPDATE`.
- Read manifest from the selected root.
- Enumerate latest normal artifact versions under root.
- Freeze exact `(artifact_id, seq, blob_sha, mime, size)` rows.
- Reject missing entry, deleted entries, missing durable `s3_key`, traversal,
  `<base>`, root-absolute refs, and dangling relative assets.

## Phase 2: signing and apps origin

Likely files:

- `surface/server/src/appsign.ts`
- `surface/server/src/apps-origin.ts`
- `surface/server/src/s3.ts`
- `surface/server/src/config.ts`
- `surface/server/src/index.ts`

Config:

- `APPS_HOST`
- `APPS_PORT`
- `APPS_ORIGIN`
- `ATRIUM_WEB_ORIGIN`
- `APP_LAUNCH_TTL_S`

Signed URL:

```text
/app/:appId/:version/g/:expires/:sig/*
```

Signing:

- HMAC over `app:${appId}:${version}:${expires}` using the existing session
  secret or a dedicated apps signing secret.
- Verify expiry and signature with constant-time compare before DB lookup.

Apps origin:

- has no API routes;
- ignores cookies;
- verifies path grant;
- resolves frozen app file;
- streams S3 bytes through apps origin;
- sets `Content-Type`, inline disposition, `X-Content-Type-Options: nosniff`,
  strict CSP, `frame-ancestors <web origin>`, and `base-uri 'none'`.

## Phase 3: API routes

Likely files:

- `surface/server/src/app.ts`
- shared API types

Routes:

- `POST /api/sessions/:id/apps`
- `GET /api/sessions/:id/apps`
- `GET /api/sessions/:id/apps/:appId/launch?version=`

Use existing session access checks. Return:

- 400 for invalid manifest/assets;
- 404 for inaccessible app/session;
- 409 for unpublished/non-published app state;
- 503 or 409 for missing durable blobs, depending on final contract.

## Phase 4: web UI

Likely files:

- `surface/web/src/sessions/AppsSurface.tsx`
- `surface/web/src/sessions/WorkDrawer.tsx`
- `surface/web/src/sessions/api.ts`
- maybe `SessionPane.tsx`

UX:

- Add an Apps tab/section in the work drawer.
- List app tiles with scope, version, status, and launch action.
- Launch fetches signed URL and renders an iframe.
- Iframe sandbox must not include `allow-same-origin`.

Recommended iframe:

```html
<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals">
```

Add relaunch for expired URLs or failed lazy assets.

## Tests

Server:

- publish freezes file set;
- later artifact edits do not mutate v1;
- concurrent publish yields v1/v2 correctly;
- missing S3 key rejected;
- dangling/root-absolute assets rejected;
- launch authorization;
- tampered/expired signature returns 403 before DB existence leak;
- apps origin streams bytes with CSP from final response;
- unknown path 404;
- traversal impossible;
- app versions keep CAS blobs alive through GC.

Web:

- app list renders;
- launch URL used in iframe;
- iframe sandbox exactness and no `allow-same-origin`;
- relaunch state.

E2E:

- fixture static app renders in iframe;
- iframe origin differs from web origin;
- cookie/storage access fails;
- `fetch` is blocked by CSP;
- tampered URL 403;
- v1 remains stable after v2 publish.

## Risks

- Security depends on streaming through the apps origin, not redirecting.
- TTL expiry can break lazy assets. V1 should use a long enough launch TTL and a
  visible relaunch affordance.
- CSP may need inline/eval allowances for simple agent-built apps. That is
  acceptable only with opaque iframe origin and `connect-src 'none'`.
- Large/many-file apps need publish caps.

