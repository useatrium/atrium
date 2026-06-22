# Artifact Apps (v1) — hosting & launching agent-built static web apps

Status: **SPEC — security model POC-verified, ready to agent-fanout** (2026-06-22).
Decisions locked with Gary via the daily-driver review; the load-bearing
browser-security claims were proved with a live 3-origin + dev-browser POC (see
§0). Sister docs: [[atrium-daily-driver-plan]] §3/§9, `agent-sync-design.md`
(Files surface polymorphism), `cas-ledger-build-plan.md` (the ledger this rides on).

## 0. Security model — POC-verified (2026-06-22)

A live POC (three real origins, the exact §6 CSP, driven through Chromium with
dev-browser) settled the load-bearing claims:

| Claim | Result | Evidence |
|---|---|---|
| Relative assets inherit the path grant | **CONFIRMED** | `app.js`/`style.css` fetched *with* the `/g/<exp>/<sig>/` prefix; root-absolute `/abs-only.js` fetched *without* → 404. |
| Sandbox (no `allow-same-origin`) → opaque origin | **CONFIRMED (stronger)** | `document.cookie` **throws SecurityError**; `localStorage` **throws SecurityError**. App can't read either. |
| `connect-src 'none'` blocks exfil | **CONFIRMED** | fetch (cross + relative) blocked; WebSocket errors; img-beacon blocked by `img-src`; **no exfil reached the API**. (`sendBeacon()` returns `true` but delivers nothing.) |
| `frame-ancestors` blocks foreign embedders | **CONFIRMED** | foreign origin → frame refused to render (server still served bytes — enforcement is client-side). |
| Tampered/expired signature rejected | **CONFIRMED** | valid → 200, tampered → 403, expired → 403. |
| Separate **port** ⇒ Atrium cookie not sent | **CONTRADICTED** | cookies are **port-blind** (RFC 6265 §8.5): the HttpOnly `atrium_session` cookie *was* sent to the apps port on the framing navigation. |

**Why the contradiction doesn't break the design.** Isolation does **not** rest on
"the cookie isn't sent." It rests on a verified defense-in-depth stack, any layer
of which suffices:
1. The Atrium session cookie is **HttpOnly** (`app.ts:472`) → app JS can't read it
   even same-origin. POC: `document.cookie` throws.
2. The iframe's **opaque origin** → cookie/storage access throws, **and** the app's
   own subresource requests carry **no** cookie (POC log: `app.js`/`style.css` →
   `cookie=NONE`, because a null-origin request is cross-site so SameSite=Lax
   suppresses it).
3. The serve route is **cookie-agnostic** (path-grant auth) — it ignores any cookie.
4. `connect-src 'none'` + `img-src 'self'` + `form-action 'self'` stop the app from
   *using* any credential against the API (POC: zero exfil receipts).

Keep `atrium_session` **HttpOnly + SameSite=Lax** (already so); add **`Secure`** in
prod. See §10 for the prod-origin recommendation.

## 0a. Flow hand-computed (2026-06-22)

A step-by-step state walk of the publish→launch→serve flow across all actors (agent,
offload worker, human, API origin, apps origin, browser) found the model sound and
surfaced one model-level correction + several route/GC/locking rules — all folded in:

1. **Coherent snapshot** — publish freezes `(artifact_id, version_seq, blob_sha,
   mime, size)` from **one MVCC snapshot/tx** and reads blobs **by seq**, never
   re-resolving `latest` (which a concurrent agent edit can move mid-publish). §6.
2. **Asset validation** — publish verifies the entry's relative asset refs exist in
   the snapshot + lints root-absolute refs → 400 (dangling/absolute). §5/§6.
3. **Durability (the big one)** — the apps origin serves **S3-only**; the
   Centaur-proxy fallback is **dropped** (evictable, no session ctx). Publish gates
   on offload via `apps.status: pending_offload → published`; launch 409s until
   published. §4/§6.
4. **Stable old launches** — per-version freeze + version-in-the-signed-path means a
   re-publish (v2) never disturbs a live v1 launch. `app_versions.blob_sha` is a
   **GC root**. §4.
5. **Bearer-capability serve** — the launch URL is a short-lived bearer token;
   membership is enforced at **mint** (launch), not at fetch (serve has no cookie).
   Serve **verifies sig before any DB lookup** (no existence leak) and checks
   `apps.status='published'`. §6.
6. **TTL vs long-open iframe** — post-expiry relative/lazy asset loads 403; TTL
   default ~6h, bundle assets, gallery offers **Relaunch** on a dead iframe. §7/§10.
7. **Concurrent publish** — serialize via upsert-app + `SELECT … FOR UPDATE` so
   parallel publishes of one name get distinct versions, no PK collision. §6.

## 1. What & why

Agents in Centaur sandboxes are **no-ingress** — they can't host anything for
outside access. But agents routinely produce *little tools/applets* (dashboards,
data viz, calculators, form-over-data utilities) that we want to hand to the team
for ongoing use, or later to other agents. Today an artifact that is an `.html`
file is force-`Content-Disposition: attachment` (download, never render) "as
defense against stored XSS" (`app.ts:2371`). There is **no hosting concept
anywhere** in the code or notes.

This adds a **publish → launch** path for **static, client-side apps** stored in
the artifact ledger, served from an **isolated origin** behind a short-lived
signed URL, embedded in a **sandboxed iframe**. It is a *deliberate, isolated
exception* to the no-inline-HTML rule — not a loosening of it.

## 2. Locked scope (from the Q&A)

| Dimension | Decision | Consequence |
|---|---|---|
| **Consumer** | **Humans lead**, agents fast-follow | v1 = Apps gallery + launch in the web UI. Agent-as-consumer (MCP tool registry) is **out of v1**. |
| **Runtime** | **Static now, dynamic later** | v1 = client-side bundles served from the ledger. No server process, no tunnel, no deploy plane. |
| **Lifecycle** | **Ladder, cheap half only** | Preview = the live session's working files (already visible in Files/Changes). Promote/Publish = **pin a version + name it + scope it**. For static there is *no uptime to manage* — durability is free once blobs are in S3. The ladder becomes load-bearing only in v2 (dynamic). |
| **Trust** | **Private + sandboxed default** | Isolated origin, signed URL, strict CSP, sandboxed iframe, membership-gated at mint time. v1 apps are **self-contained** (`connect-src 'none'` — no Atrium API calls), which removes the CSRF/token surface entirely. |

### Explicitly OUT of v1 (named so we don't scope-creep)
- **Dynamic / server-backed apps** (own process/DB/external calls) → needs the v2
  "run agent code on demand" plane (tunnel for preview, deploy for durable).
- **Agent-callable tools** (MCP registry, FaaS execution) → v2, reuses the same
  registry spine.
- **Scoped-token data SDK** (let an app read live Atrium data via a `postMessage`
  capability token, relaxing `connect-src`) → v1.1. v1 apps bake data in at
  publish or compute client-side.
- **Prod multi-origin DNS/TLS** (wildcard `*.apps.atrium.…`) → dev uses a second
  **port** (a real separate origin for free); prod hostname is an ops follow-up.

## 3. Architecture

```
 author (agent)            publish (human/agent)        consume (human)
 ─────────────             ─────────────────────        ───────────────
 writes apps/<name>/   →   POST /api/sessions/:id/apps  →  Apps gallery tile
   atrium.app.json          freezes file set → app_versions   │ "Launch"
   index.html app.js          (pin = durable, named)          ▼
   ...                                                  GET …/apps/:appId/launch
   (captured to ledger                                   (membership-gated)
    via existing C4 path)                                  → signed URL
                                                              ▼
                                            sandboxed <iframe src=signed-url>
                                                              ▼
                                  ISOLATED ORIGIN  GET /app/:appId/:ver/g/:exp/:sig/*
                                    verify sig → resolve frozen blob → serve inline
                                    + strict CSP, nosniff, frame-ancestors=atrium
```

Two Fastify listeners share one pool/S3/SessionRuns:
- **API origin** (`:3101` dev / today's server): registry + publish + launch
  (cookie-authenticated, `requireSessionAccess`).
- **Apps origin** (`:3102` dev, separate **port = separate origin**; separate
  **hostname** in prod): *only* `GET /app/...`, **no cookie auth** — HMAC signed
  path grant. NB (POC §0): the Atrium cookie *is* sent here on the framing
  navigation (cookies are port-blind), but it is **inert** — HttpOnly +
  cookie-agnostic serve + opaque-origin sandbox + `connect-src 'none'`. Isolation
  is the defense-in-depth stack, not "cookie not sent."

### Why the signed grant lives in the path
A strict sandbox iframe (`sandbox` minus `allow-same-origin`) gets an **opaque
origin** → no cookies/storage → relative asset requests (`./app.js`) can't carry
a `?sig=`. Putting the grant in a **path prefix** (`/app/:appId/:ver/g/:exp/:sig/…`)
makes relative URLs inherit it automatically. No cookies; strict sandbox intact;
multi-file works; traversal is impossible (serving is a keyed DB lookup of the
frozen set, not a filesystem walk).

## 4. Data model — `migrations/041_apps.sql`

Migrations are at 040; this is **041**. Reuses `cas_blobs` (sha→S3) and the
`artifacts`/`artifact_versions` chains from mig 033; adds the *pin* layer.

```sql
-- A named, versioned, pinned static app: a frozen snapshot of the ledger
-- artifacts under apps/<name>/ for one workspace.
CREATE TABLE IF NOT EXISTS apps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id      uuid REFERENCES channels(id) ON DELETE SET NULL, -- provenance
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL, -- provenance
  name            text NOT NULL,                 -- slug, [a-z0-9][a-z0-9_-]*
  root_path       text NOT NULL,                 -- 'apps/<name>/' (the ledger prefix)
  entry           text NOT NULL DEFAULT 'index.html',  -- rel to root_path
  description     text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  current_version int,                           -- latest published app_versions.version
  status          text NOT NULL DEFAULT 'pending_offload',  -- pending_offload | published | unpublished
  UNIQUE (workspace_id, name)
);
-- status machine (hand-compute §0a): a publish freezes rows as 'pending_offload';
-- once every referenced blob has cas_blobs.s3_key, it flips to 'published'. launch
-- refuses non-'published' (409); serve gates on 'published'. unpublish → live apps
-- die within one asset-load. The apps origin serves ONLY from S3 (durable), never
-- proxies Centaur staging (evictable; no session ctx) — so publish MUST reach S3.

-- One row per (app, version, file): freezes the EXACT artifact version served,
-- decoupled from the live chain (later edits don't mutate a published app).
-- Immutable once written. blob_sha denormalized so serve needs no chain join.
CREATE TABLE IF NOT EXISTS app_versions (
  app_id        uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version       int  NOT NULL,                   -- monotonic per app, 1-based
  rel_path      text NOT NULL,                   -- rel to root_path, e.g. 'app.js'
  artifact_id   uuid NOT NULL,                   -- the source ledger artifact
  version_seq   int  NOT NULL,                   -- frozen seq in that chain
  blob_sha      text NOT NULL REFERENCES cas_blobs(sha256),
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version, rel_path)
);
CREATE INDEX IF NOT EXISTS app_versions_lookup ON app_versions (app_id, version);
```

**Why snapshot rows, not a commit-group (mig 038) or a `latest` pointer:**
serving `latest` under a prefix would let the app mutate mid-use while the author
keeps editing — exactly what publish must prevent. Commit-groups are tied to the
`artifact_changes` changefeed (mig 038), not the version chain, so coverage of an
app's full file set isn't guaranteed. Freezing `(artifact_id, version_seq,
blob_sha)` per file is self-contained and obviously correct. (Commit-groups can
later *drive* publish — "publish this group" — without changing this table.)

**GC root (hand-compute §0a, scenario d):** `app_versions.blob_sha` is a **GC root**
for `cas_blobs` — extend the blob-GC mark phase to scan it. A published app must
survive even after its source session/artifact is GC'd; this decouples app
durability from session lifecycle (required for "ongoing usage").

## 5. Authoring contract — `atrium.app.json`

Zero-ceremony, matches the "detect → promote, CLI is the power tool" doctrine.
Agent writes a dir under the artifact namespace; the manifest makes it
publishable and declares intent. Forward-compatible to v2.

```jsonc
// apps/weather/atrium.app.json
{
  "name": "weather",          // slug; must match dir
  "kind": "static",           // v1 only accepts "static"; "service" reserved for v2
  "entry": "index.html",      // rel to the app dir
  "description": "7-day forecast widget",
  "scopes": []                // RESERVED for v1.1 scoped-token SDK; ignored in v1
}
```

App files live at `apps/<name>/…`. `classifyScope('apps/<name>/')` → root-prefix
→ **workspace-wide** (team-visible), which is what "give it to the team" wants.
(`scratch/<session>/apps/…` would stay private; supported by the same scope layer,
not a v1 deliverable.)

**Authoring constraint — relative asset paths only (POC §0).** The path-grant is
inherited only by **relative** URLs. **Root-absolute refs (`/app.js`), `<base href>`
overrides, and SPA `pushState` routing do NOT inherit the grant** → they hit the
apps origin without a signature → 403/404. Publish **lints and rejects** an app
whose HTML/CSS contains root-absolute asset refs (cheap regex over the entry +
linked files), with a clear error; agents author with relative paths. (A future
rewrite-to-relative pass could relax this.)

## 6. API surface

### API origin (cookie-authenticated, `requireSessionAccess`)

- **`POST /api/sessions/:id/apps`** — publish/promote. In **one transaction**
  (hand-compute §0a): `SELECT … FROM apps WHERE (workspace,name) FOR UPDATE` (upsert
  the row first so concurrent publishes of one name serialize → distinct versions);
  read `apps/<name>/atrium.app.json` (manifest overrides body), **reject
  `kind!="static"` → 400**; enumerate latest-normal versions under `apps/<name>/`
  from **one snapshot**, freeze `(artifact_id, version_seq, blob_sha, mime, size)`
  **by seq** into `app_versions` at `current_version+1`; **validate** `entry` exists
  + every relative asset ref in the entry resolves in the snapshot + **lint
  root-absolute refs** (→ 400 on dangling/absolute); set `status='pending_offload'`,
  bump `current_version`. Then ensure offload is enqueued for those blobs (the
  **existing** artifact-offload worker stamps `s3_key`). `status` flips to
  `published` **lazily** — no new worker (see launch). Membership + scope gated. →
  `{ appId, version, status }`.
- **`GET /api/sessions/:id/apps`** — registry list for the session's workspace,
  scope-gated (`userCanReadScope`). → `[{ appId, name, entry, description,
  version, status, createdBy, createdAt }]`.
- **`GET /api/sessions/:id/apps/:appId/launch?version=`** — membership+scope
  gated. **Lazy status flip:** if `status='pending_offload'`, re-check whether all
  referenced blobs now have `s3_key`; if so flip to `published`, else **409**. Then
  mint the signed URL for `version` (default `current_version`). → `{ url, expiresAt }`.
  (This is why no offload-flip worker is needed — durability is confirmed at the
  moment of launch.)

### Apps origin (NO cookie; HMAC path grant — S3-only, durable)

- **`GET /app/:appId/:version/g/:exp/:sig/*`** — (1) `verifyAppSignature` +
  `exp*1000 > now` **first**, **before any DB lookup** (bad sig → 403 regardless of
  app existence → no existence leak); (2) read `apps.status` — must be `published`
  (else 404); (3) resolve `app_versions(appId, version, relPath=*||entry)` → blob;
  (4) **302 → presigned S3** (Content-Type + inline disposition baked in). **No
  Centaur-proxy fallback** — publish guarantees S3-durable bytes, and the apps
  origin has no session context (hand-compute §0a, scenario b). Always sets the
  strict CSP (below) + `nosniff`. Unknown rel_path → 404.
- **`GET /healthz`**.

### Signature — `appsign.ts` (generalize `filesign.ts`)
```
appSignature(appId, version, expires, secret) =
  base64url(HMAC-SHA256(secret, `app:${appId}:${version}:${expires}`))
```
`config.sessionSecret` as the key; TTL `appLaunchTtlS` (default **~6h / 21600s** —
long enough for an open iframe's eager+lazy asset loads, short enough to bound a
leaked bearer URL; hand-compute §0a — one
sig covers the whole app tree's asset loads). `verifyAppSignature` is constant-time
(`timingSafeEqual`) and checks expiry, exactly like `verifyFileSignature`.

### CSP on every app response
```
Content-Security-Policy:
  default-src 'self'; img-src 'self' data: blob:;
  style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval';
  connect-src 'none'; frame-ancestors <ATRIUM_WEB_ORIGIN>;
  base-uri 'none'; form-action 'self'
X-Content-Type-Options: nosniff
```
- `connect-src 'none'` enforces the v1 "self-contained, no Atrium calls" cut.
  POC-verified to block fetch/XHR/WebSocket/`sendBeacon` *delivery* (note:
  `sendBeacon()` *returns* `true` but nothing is delivered — don't trust the
  return value). `img-src 'self'` is what blocks image-beacon exfil.
- `frame-ancestors <web origin>` → only our gallery may frame it (anti-clickjack);
  POC-verified to block a foreign embedder.
- `'unsafe-inline'/'unsafe-eval'` are tolerated because the origin is isolated +
  sandboxed + can't exfil (`connect-src none`). **Hardening (hashed CSP, drop
  `unsafe-eval`) is a follow-up**, noted not done.
- **v1.1 caveat:** `connect-src 'none'` does **not** cover URL navigation
  (`location=`, `window.open` under `allow-popups`). Harmless in v1 (the app holds
  nothing secret), but once the v1.1 scoped-token SDK gives an app a capability
  token, reconsider dropping `allow-popups` and constraining navigation so the
  token can't be carried out in a URL.

## 7. Web UI (Apps surface)

Model the Apps tab like **Files** ("Browse files"): an always-available tab whose
surface **self-fetches** from the registry endpoint (FilesSurface pattern,
`credentials: 'same-origin'`) — apps are a durable registry, not session-stream
state, so no reducer/stream coupling.

- **`AppsSurface.tsx`** — gallery of `{name, description, version badge, status}`
  tiles + "Launch". `pending_offload` apps show "publishing…" and Launch is
  disabled. Launch → `GET …/launch` → render the returned `url` in a sandboxed
  iframe (modal/expanded):
  ```tsx
  <iframe
    title={app.name}
    sandbox="allow-scripts allow-forms allow-popups allow-modals"  // NO allow-same-origin
    src={signedUrl}
    onError={showRelaunch}   // dead iframe (sig expired, 403) → "Relaunch" re-mints
  />
  ```
  **Relaunch** (hand-compute §0a): a launch URL is a ~6h bearer token; after expiry,
  relative/lazy asset loads 403. On a dead/blank iframe the gallery offers Relaunch
  (re-`GET …/launch`, reset `src`). Don't auto-refresh a live iframe (reload loses
  app state).
- **`WorkDrawer.tsx`** wiring: add `'apps'` to `WorkTab` / `TAB_SLUG` /
  `SLUG_TAB` / `TAB_LABEL` (`'Published apps'`) + the render switch (lines
  ~15-42, ~200-221) + an `apps-strip` testid (mirror `conflicts-strip`).
- **`api.ts`**: `listApps(sessionId)`, `launchApp(sessionId, appId, version?)`,
  optional `publishApp(sessionId, body)` via the `reqJson` helper.
- **Publish control (minimal)**: a "Publish" button in AppsSurface/FilesSurface
  shown when an `apps/<name>/atrium.app.json` is detected → calls `publishApp`.
  (Agents can also just call the API directly; the human button is the convenience.)

## 8. Build lanes (agent-fanout)

Foundation first as a **single committed task**; then A/B/C in parallel; D last
(exercises the whole path). Disjoint ownership; shared-file edits are in distinct
files or appendix blocks. Runner = **codex** for all (judgment + tests); follow
`agent-fanout` skill (persistent worktrees, warm `node_modules`+`.env`, pre-warm
the dev-browser daemon, `--sandbox workspace-write`,
`network_access=true`, `default_mode_request_user_input=false`).

### F — Foundation (commit before fan-out)
Owns: `migrations/041_apps.sql`; `surface/server/src/app-registry.ts`
(`publishApp`, `listApps`, `resolveAppFile`, `getApp`); `surface/server/src/appsign.ts`;
`config.ts` additions (`appsOrigin`, `appsHost`, `appsPort`, `appLaunchTtlS`);
shared `AppManifest` type + validator (in `@atrium/surface-client` next to `prefs`).
`publishApp` does the §6 tx (`FOR UPDATE` + freeze-by-seq + asset/absolute-ref
validation + `status='pending_offload'`); `markPublishedIfDurable(appId, version)`
is the lazy-flip helper (all blobs `s3_key` → `published`); `resolveAppFile`
returns blob_sha + `s3_key` only (no Centaur).
Tests: `surface/server/test/appRegistry.test.ts` — publish **freezes** the set (a
later edit does NOT change a published app); `resolveAppFile` returns the frozen
seq; `listApps` scope-gates; **concurrent publish → distinct versions** (hand-compute
h); **pending→published only after all blobs durable** (hand-compute b); validation
**rejects dangling + root-absolute refs** (hand-compute a). `appSign.test.ts`
(sign/verify, expiry, tamper). **The shared contract every other lane imports.**

### A — API-origin routes (codex)
Owns: an appendix block `// === apps routes ===` in `app.ts` (the 3 routes in §6)
+ `surface/server/test/appsRoutes.test.ts` (publish→list→launch happy path;
non-member → 404; `kind!=static` → 400; **launch 409 while `pending_offload`, then
200 after blobs durable** (hand-compute b); launch URL verifies under
`verifyAppSignature`).

### B — Apps-origin server + serve + CSP (codex)
Owns: `surface/server/src/apps-origin.ts` (`buildAppsOrigin(deps)` + the serve
route + CSP/headers + **sig-verify-before-DB-lookup** + **status-gate** +
**S3-redirect only, NO Centaur proxy**) and the entrypoint edit
(`surface/server/src/server.ts`/`index.ts`) to also `listen` on
`config.appsPort`/`appsHost` when configured (default on in dev). Tests:
`surface/server/test/appsServe.test.ts` (valid sig → 302→presigned S3 with all CSP
directives incl. `connect-src 'none'` + `frame-ancestors` + `nosniff`; expired/
tampered → 403 **even for a nonexistent app** (no existence leak, hand-compute f);
`unpublished` status → 404; unknown rel_path → 404; relative prefix carries the
grant).

### C — Web Apps surface (codex)
Owns: `surface/web/src/sessions/AppsSurface.tsx`; `WorkDrawer.tsx` tab wiring;
`api.ts` helpers; the minimal Publish control. Tests:
`surface/web/test/appsSurface.test.tsx` (renders list; Launch fetches the launch
URL and mounts an iframe with the **exact** `sandbox` value and **no**
`allow-same-origin`; src = returned signed URL). Visual QA via dev-browser
(gallery + a launched fixture app rendering).

### D — E2E + fixture (codex)
Owns: `surface/e2e/fixtures/sample-app/` (self-contained: `index.html` + `app.js`
+ `style.css`; e.g. a counter / canvas chart with **baked-in** data — must run
under `connect-src 'none'`); a seed helper that writes the fixture into the ledger
for a seeded session (mirror `conflicts.spec.ts` `writeArtifact`) then publishes
via the API; `surface/e2e/tests/apps.spec.ts`. Beyond the §9 isolation assertions,
exercise: **launch before offload → 409** then after → 200 (hand-compute b);
**re-publish v2 while a v1 iframe is open → v1 keeps serving** (hand-compute d).
Config: set `APPS_PORT` in `playwright.config.ts` `webServer` env so the server
boots the apps origin (`:3201` e2e) + MinIO for the offload path.

**Dependency graph:** F → {A, B, C} → D. C builds against F's contract types; D
exercises A+B+C end to end.

## 9. Test & verification plan

| Layer | What | Command |
|---|---|---|
| Unit (server) | registry freeze/resolve/scope; sign/verify | `pnpm --filter @atrium/server test` |
| Integration (server) | routes: publish/list/launch authz; serve sig/expiry/tamper/traversal/CSP | same |
| Unit (web) | AppsSurface list + launch iframe attrs | `pnpm --filter @atrium/web test` |
| Whole suite | typecheck + lint + tests | `pnpm check` (from `surface/`) |
| **E2E** | seed → publish → launch → iframe renders + **isolation** | `pnpm e2e` (needs PG `:5433` `atrium_e2e`; MinIO `:9000` for offload path) |
| **Manual (orchestrator)** | dev-browser: launch app, screenshot, confirm render + sandbox | per `agent-fanout` final-QA |

### E2E spec outline (`apps.spec.ts`)
1. `login(page, unique('apps-user'))`; `channelId(ctx,'general')`; `seedSession(...)`.
2. Seed the fixture files into the ledger for the session; `POST …/apps` to publish.
3. Mock `**/api/sessions/*/stream*` to a terminal frame (so the pane settles).
4. `goto(/s/:id)` → open the **Apps** strip → assert the tab + tile.
5. Click **Launch** → `expect(drawer.locator('iframe')).toBeVisible()`;
   `frameLocator('iframe').getByText('<fixture marker>')` visible.
6. **Isolation assertions (the security acceptance, in-test — corrected per POC §0):**
   - iframe `src` is on the **apps origin/port**, not the web origin.
   - inside the frame, reading `document.cookie` **throws `SecurityError`** (NOT
     `''`), and `localStorage` access **throws** — the app can't read cookies/storage.
     (Do **not** assert "cookie not sent over the wire" — it is, and that's fine.)
   - a `fetch('<api>/api/...')` and `fetch('./asset')` from inside the frame are
     **blocked** (`connect-src 'none'`); the API logs **no** request from the app.
   - a foreign-origin page (e.g. `127.0.0.1` vs `localhost`) **cannot render** the
     app (frame-ancestors).
   - tampered/expired launch URL → **403**.

### Security acceptance criteria (must all pass before merge)
- [ ] App bytes served **only** with a valid, unexpired signature; expired/tampered → 403. *(POC-confirmed)*
- [ ] App code **cannot read** cookies/storage — `document.cookie`/`localStorage` throw `SecurityError` in the sandbox. *(POC-confirmed; the Atrium cookie stays HttpOnly. It IS sent to the apps origin — cookies are port-blind — but is inert: cookie-agnostic serve + opaque-origin + connect-src.)*
- [ ] CSP present with `connect-src 'none'` + `frame-ancestors <web origin>`; `nosniff` set. *(POC-confirmed to block fetch/XHR/WS + foreign embed)*
- [ ] Path traversal under the serve route impossible (keyed lookup of the frozen set).
- [ ] Non-member can neither list an app nor mint a launch URL (membership + scope gated).
- [ ] Unpublished/preview working files are **not** servable via the apps origin — only frozen published versions.
- [ ] A later edit to a source file does **not** alter an already-published app version. *(hand-compute d)*
- [ ] Launch **409s** while `status='pending_offload'`; serve is **S3-only** (never proxies Centaur). *(hand-compute b)*
- [ ] A re-publish (v2) does **not** disturb a live v1 launch; `app_versions.blob_sha` is a blob-GC root. *(hand-compute d)*
- [ ] Concurrent publishes of one name produce **distinct versions** (no PK collision; serialized via `FOR UPDATE`). *(hand-compute h)*
- [ ] Serve **verifies the signature before any DB lookup** (bad sig → 403 whether or not the app exists). *(hand-compute f)*

## 10. Risks / open items
- **Prod second origin** — dev/e2e use a separate **port** (a true origin for
  frame-ancestors/CORS, though **not** a cookie boundary — cookies are port-blind,
  POC §0). Prod needs a separate **hostname** + TLS. **Recommended: a separate
  registrable domain** (e.g. `atrium-apps.io`), so the Atrium cookie is cross-site
  and SameSite suppresses it entirely (clean boundary + kills the same-site
  state-changing-GET edge). A **subdomain** (`apps.atrium.io`) is *acceptable*
  because the §0 defense-in-depth holds regardless (HttpOnly + opaque origin +
  cookie-agnostic serve + connect-src), **provided** `atrium_session` stays
  host-only (no `Domain` attr — already so) + HttpOnly + `Secure`. Per-app
  subdomain (`<id>.atrium-apps.io`) additionally isolates apps from each other.
  Ops follow-up; not a v1 code blocker.
- **CSP permissiveness** — `unsafe-inline/eval` accepted under isolation; harden
  to hashed CSP later.
- **Durability vs offload — RESOLVED (hand-compute §0a):** apps serve **S3-only**;
  no Centaur-proxy fallback. Publish freezes as `pending_offload`; launch **lazily
  flips** to `published` once all blobs have `s3_key` (no new worker — reuses the
  existing offload worker that stamps `s3_key`), else 409. So a launch never serves
  evictable staging bytes.
- **Launch-URL TTL vs long sessions (hand-compute §0a)** — the URL is a ~6h **bearer
  capability**; post-expiry relative/lazy asset loads 403. Mitigate: bundle assets;
  gallery "Relaunch" on a dead iframe. v1.1: postMessage renew. Also note the bearer
  URL is shareable-within-TTL by design (membership enforced at mint, not fetch).
- **Large/many-file apps** — reuse the ~16 MiB capture ceiling + offload; cap file
  count/total size at publish; surface a clear error.
- **v1.1 hook** — `scopes` in the manifest + a `postMessage` capability-token SDK
  relax `connect-src` to a single data endpoint so apps can read live Atrium data
  without ambient auth. Designed-for, not built.
- **v2 hook** — `kind:"service"` + the "run agent code on demand" plane (tunnel
  preview → durable deploy) and the MCP tool registry for agent consumers reuse
  this registry/manifest/ladder spine unchanged.
```
