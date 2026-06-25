# Shared Workspace — workspace-scoped artifact identity (the keystone build spec)

> **Status: 2026-06-23. BUILT + LANDED end-to-end (both repos).**
> Atrium `master`: workspace-scoped ledger re-key (mig `042`) + shared write + upload on-ramp
> + per-workspace gap-free lock (mig `043`) + internal hydration-scope route w/ blob-sha —
> PRs **#82** (`cd1352e`), **#83** (`e4b2e86`), **#84** (`2fc4cd0`). `gbasin/centaur` `main`:
> 5B-3 `hydrate_lower` (**#12** `dc2825b`) + **live daemon hydration proven in a real kind
> cluster** (**#13** `4039e0c`) — the `node-sync-pod-e2e` asserts the agent reads
> `/workspace/shared/hydrated.md`. Hydration is gated default-OFF (`NODE_SYNC_HYDRATE_ARTIFACTS`
> / `--hydrate-artifacts`). **Correction vs the original plan: the Centaur overlay work WAS
> doable from the Mac** (the kind/k3s node is a Linux VM; local `kind-centaur` + the fork's
> GHA-kind CI — how 5B-1/2/3 all landed). **Still genuinely remaining (future, not blocking):**
> the agent-FS ergonomic rename (`~`/`shared`/`repos`/`context`), live-controller production
> wiring (mount the overlay + enable hydration by default; today prod still uses the git-clone +
> 2.5s in-agent poll), a full-Atrium (non-mock) hydration e2e, retiring the in-agent poll once
> C4 is parity-checked, and reconciling the vestigial `runtime::hydrate_lower` with
> `cas::hydrate_artifact_lower`. The §8 prod-data decisions remain confirm-before-prod-apply.
>
> Consolidates the decided-but-planless keystone surfaced by two threads:
> the file-types `PREREQUISITE` finding (`artifact-file-types-design.md` §10, committed
> `d745437`) and the C4 overlay-capture line (`c4-overlay-provisioning-plan.md`, 5B-1/5B-2
> merged to `gbasin/centaur` `fork/main` @ `ebdf762`).
> **Decisions it implements:** `cas-ledger-build-plan.md` §10.1 (`(workspace, fullpath)`
> identity, path-prefix scope), §10.7/§10.8 (path/filter carries policy; repos excluded),
> and `agent-sync-design.md` §2A/§4/§5/§5B (shared visibility; node-side merge; hydration =
> a CAS checkout of a subscription set). The 2026-06-25 clarification narrows "shared by
> default" to one active shared leaf at `~`, plus explicit session scratch.
> **What it unblocks:** a filesystem-feeling agent home where humans drop files and agents
> read **and edit** them like any artifact — and it **re-scopes Centaur 5B-3** from
> single-session hydration to an authorized subscription set (lane E below).

---

## 0. CONVERGED DESIGN (2026-06-25 scope/mount clarification with Gary — canonical; supersedes the posture/path opens elsewhere)

Settled by walking real human + agent user stories. The test that drove every call:
*a context-free agent drops in, runs `ls`, and gets it — without learning a taxonomy.*

### 0.1 The agent's filesystem — cwd is the active shared scope
```
~  (= /home/agent; the active shared scope, and usually the CWD)
  report.md              ← shared active-scope artifact
  data/                  ← shared active-scope artifact subtree
  scratch/               ← this session's private durable artifact scope
  shared/                ← server-owned shared-scope library / aliases
    global/              ← workspace-wide files
    channels/<channel>/  ← channel files; first layer is Atrium-owned
    projects/<project>/  ← project files, only once projects are real product objects
  repos/<owner>/<repo>/  ← git checkouts. NOT artifact-synced (git owns them; cas-ledger §10.7).
  context/               ← READ-ONLY: chat transcripts + sibling sessions + ledger search.
                           (renamed from /atrium — "context" is self-evident to a no-context agent)
  .claude .codex .state  ← (hidden) harness/auth/state — never captured as artifacts
```
- **Work goes where the agent lands.** For non-repo work, Atrium sets CWD=`~`, and `~` is an
  alias/materialized view of one active shared leaf (usually the channel/task scope). A naive
  `report.md` is therefore shared with the humans/agents in that active scope, not orphaned.
- **Private durable work is named.** `~/scratch/foo` maps to `scratch/<session-id>/foo`. It uses
  the same CAS/version/artifact machinery and is visible in the GUI to authorized humans, but it
  is not hydrated into sibling sessions by default. Promote by moving/copying into `~` or
  `~/shared/...`.
- **Atrium owns scope directories.** Agents may create arbitrary files/subdirs inside a mounted
  leaf (`~`, `scratch/`, `shared/channels/<active>/...`, `shared/global/...` if granted), but they
  do not create new scopes by `mkdir shared/channels/new-channel`. First-layer scope dirs are
  generated from product objects.
- **Reserved root names.** `scratch`, `shared`, `repos`, `context`, and dotdirs are reserved at
  the active-root level. If a human upload would collide with one of these exact names, the UI must
  escape/rename it; agents should never have to resolve an ACL collision by folder naming.
- **Configurable landing.** The spawn sets CWD = `~` (general/deliverable task), `~/repos`, or
  `~/repos/<repo>` (code task). Same layout; only the entry point differs.
- **`context/` is words; `shared/` is explicit file scopes.** The active scope is direct in `~`
  and mirrored at `shared/channels/<active>/`; `shared/global/` is the broader shared scope. Other
  channel/project leaves stay closed until Atrium has product grants for them.
- **Today's reality (grounded):** HOME=`/home/agent`; CWD=`~/workspace` (a per-session git clone);
  `.claude`→`state/claude` (auth+transcript), `.codex`→`state/codex` are symlinks into the
  persistent `state/` volume, already outside the captured tree. The `/workspace` mount + `/atrium`
  are the gated overlay path. This design replaces the per-session clone with the flat layout above.

Canonical path mapping (v1 stays path-prefix based; no `artifact_spaces` table yet):

| Agent-visible path | Canonical artifact path | ACL / hydration |
|---|---|---|
| `~/report.md` | `shared/channels/<active-channel-id>/report.md` (or another selected shared leaf) | active shared scope; hydrated to sessions in that scope |
| `~/shared/global/handbook.md` | `shared/global/handbook.md` | workspace-wide, if the session has write permission |
| `~/shared/channels/<active-channel-id>/plan.md` | `shared/channels/<active-channel-id>/plan.md` | same active channel chain as `~/plan.md`; non-active channels are future ACL work |
| `~/scratch/draft.md` | `scratch/<session-id>/draft.md` | this session + authorized humans; not sibling sessions |
| `~/repos/org/repo/file.ts` | git lane | excluded from artifact capture |
| `~/context/...` | read-only projection | excluded from artifact capture |

### 0.2 Uploads / attachments → `shared/` by default (reverses file-types §9.5)
Every human drop lands as an editable artifact in the current shared leaf, normally
**`shared/channels/<channel-id>/uploads/<name>`** — no "attachment limbo," no promotion step, no
separate top-level `~/uploads` concept. For sessions whose active scope is that channel, the file
also appears at **`~/uploads/<name>`**.
- **Chat immutability via version-pinning:** the chat message references the pinned
  `(artifact, seq)` it was posted with, so editing the file later (v2, v3) never rewrites history.
  Editable file + immutable chat + one blob.
- **Collision rule:** identical bytes (same sha) → dedup to one artifact. Different bytes, same
  name → disambiguate like a Downloads folder (`screenshot.png`, `screenshot-2.png`) — never
  collapse two unrelated drops onto one version chain.
- **`files` table = ingest record** (presigned-PUT target + `content_hash`); the upload then
  creates the `shared/channels/<channel-id>/uploads/` artifact pointing at the **same** CAS blob (zero-copy
  via server-verified `content_hash` → `cas_blobs`).
- **Subsumes a build piece:** uploads are ordinary shared artifacts → they ride the normal
  `hydrate_lower` path into the workspace; no separate "materialize attachment bytes" mechanism.

### 0.3 Scope = reserved path prefixes, not a new identity key
The v1 ledger remains **`UNIQUE(workspace_id, path)`**. Scope/ACL is derived from a tiny set of
server-owned top-level prefixes, using longest-prefix matching. Do **not** add arbitrary per-folder
ACLs or let agents create scopes by creating folders.

- `shared/global/...` → workspace-wide shared artifacts.
- `shared/channels/<active-channel-id>/...` → the active channel shared artifacts for this session.
- `shared/projects/<project-id>/...` → project shared artifacts, only after projects are real
  product objects with an Atrium ACL resolver. The current resolver rejects `shared/projects/...`
  and non-active `shared/channels/...` rather than accepting arbitrary ids.
- `scratch/<session-id>/...` → session-scoped artifacts (same artifact machinery; narrower ACL).

The agent-visible root `~` is not a separate canonical prefix. It is an alias to one selected
`shared/...` leaf. The sync daemon/server must canonicalize aliases before ledger/writeback/sync
state, so `~/report.md` and `~/shared/channels/<active>/report.md` cannot create two artifact
chains for the same file.

### 0.4 Build scope — what lands to master NOW vs. the Centaur follow-on
- **NOW (Atrium, landable to `master`, no cluster):** the server-side foundation — 042 identity +
  workspace-scoped ledger fns + canonical alias resolver + shared write +
  upload→`shared/channels/<channel-id>/uploads/` on-ramp + `classifyScope` for the new layout +
  `activePrefix` on hydration/changefeed responses. Fully e2e-testable vs local PG:5433 +
  MinIO:9000. = **lanes A–D** below.
- **NOW (Centaur, no cluster):** node-sync HTTP client projects server canonical paths to the flat-home
  local view: `shared/channels/<active>/foo` → both `foo` and
  `shared/channels/<active>/foo` (same base seq, one canonical server path),
  `scratch/<session-id>/foo` → `scratch/foo`, all other shared scopes stay under `shared/...`.
- **FOLLOW-ON (Centaur, needs a real cluster):** live agent FS layout wiring
  (flat home, `context/` rename, active-root + `shared`/`scratch`/`repos` mount polish),
  live overlay + daemon wiring (lane F), and full-Atrium hydration e2e. Tracked in
  `c4-overlay-provisioning-plan.md` + [[c4-overlay-capture-build]].

---

## 1. Goal

One product sentence (Gary): **a filesystem-feeling workspace where the agent writes in cwd and
the right people see it.** Two sessions in the same active scope see and co-edit the same files;
a human upload and an agent write land in the same namespace and version chain; private session
scratch is still an artifact surface, just with a narrower ACL. Scope is a **reserved path
prefix**, not a new column or tag (`cas-ledger §10.1`).

This is "build the decided design," not a redesign. The committed direction is shared
artifact visibility with path-prefix policy; §0 clarifies the ergonomic mount shape as
active shared root + explicit session scratch. The implementation is **session-siloed on both
repos today**.

## 2. Current state — strictly session-scoped silos (grounded 2026-06-22, both repos)

**Tenancy already supports the target** (this is what makes the migration cheap):
- `workspaces(id, name)` → `channels(workspace_id NOT NULL, …)` → `sessions(workspace_id NOT
  NULL, channel_id NOT NULL)` (`001_init.sql:19-31`, `002_phase2_sessions.sql:4-21`).
  **Every session already carries `workspace_id`** → the re-key backfill is a single join.
- `workspace_members(workspace_id, user_id)` is the membership gate (`023_workspace_members.sql`).
- `files` (human uploads) are **already workspace-scoped** (`workspace_id NOT NULL`, no session
  link, opportunistic `content_hash` dedup) (`006_files.sql`, `020_upload_content_hash.sql`).
- `classifyScope(path)` already maps prefixes → scope classes (`artifact-scope.ts`); used for
  **ACL only** today, reusable as the reserved-prefix classifier for `shared/...` and
  `scratch/...`.

**The ledger is the silo** (everything below is `WHERE session_id = $1`):
- `artifacts`: identity `UNIQUE (session_id, path)`, `session_id NOT NULL … ON DELETE CASCADE`,
  `channel_id NOT NULL` denormalized (`033_artifact_ledger.sql:26-35`). Artifacts **die with the
  session**.
- `resolveOrCreateArtifactLocked` keys `(session_id, path)` via `ON CONFLICT` → an edit of
  another session's file **forks a new row, not a new version** (`artifact-ledger.ts:207-224`).
- `sessionScope` (hydration seed), `changesSince` (egress feed), `serveResolution`,
  `getConflict`, `resolveVersion` — **all session-keyed** (`artifact-ledger.ts:505-516,335-385,
  397-439,444-469,742-791`).
- `artifact_changes` indexed `(session_id, xid, id)`; trigger denormalizes `session_id, path`
  off the artifact (`034_artifact_changefeed.sql:16-60`).
- HTTP: every artifact route is `/api/sessions/:id/artifacts/*` and `/api/internal/sessions/:id/
  artifacts/*` (`app.ts:2393,2717,2792,2899,3129,3275,3300`). **No workspace-level route.**
  `PUT /api/channels/:channelId/artifacts` requires a `session` param despite the name
  (`app.ts:2084-2142`). `FilesSurface` only edits the session's own paths; **no "add file to
  workspace" flow** (`FilesSurface.tsx`); uploads go to `files`, invisible to agents.

**Centaur is single-session too:**
- `centaur-node-sync` HTTP client hardcodes `/api/internal/sessions/{session_id}{suffix}`
  (`http_client.rs:32-37`); it polls one session's `/artifacts/changes` and fetches via
  `/artifacts/raw` (`http_client.rs:118,148`). No subscription set, no workspace source.
- The live api-rs controller mounts `/workspace` as a bare **`EmptyDir`**
  (`centaur-sandbox-agent-k8s/src/lib.rs:903-904`) — the overlay isn't in the live path.
- The multi-session DaemonSet is designed but unwired (`nodeSync.enabled: false`); 5B-1/5B-2
  proved the overlay machinery in a kind e2e, not the production controller.

## 3. Target model

- **Identity = `(workspace_id, canonical_path)`** (`cas-ledger §10.1`). `session_id`/`channel_id`
  stay nullable provenance, not identity. Artifacts **outlive sessions** except where retention
  later prunes a scoped subtree.
- **Scope folds into reserved path prefixes** (no new `space_id` in v1):
  - `shared/global/...` → workspace-wide files.
  - `shared/channels/<active-channel-id>/...` → the active channel files for this session.
  - `shared/projects/<project-id>/...` → project files, only once project is a product object
    and the resolver can authorize it. Current code rejects this prefix.
  - `scratch/<session-id>/...` → session files. Same CAS/version/writeback/GUI surface; narrower
    ACL and not hydrated into sibling sessions by default.
- **Access follows longest matching prefix**: workspace membership, channel membership, project
  membership, or session authorization. No arbitrary nested ACLs; subdirectories inherit the
  scope leaf's ACL.
- **`artifact_sync_state` remains per session and path after canonicalization** — it is the
  per-container working-copy base/upper state; each agent has its own `upper` even for a shared
  artifact. The implementation must key it by the canonical artifact path, not by both aliases
  (`~/foo` and `~/shared/channels/<active>/foo`).
- **Repos excluded from sharing** (`cas-ledger §10.7`): anything under a git working tree is
  filtered out of the shared pool; deliverables live *outside* repo roots.
- **Conflict engine unchanged** — the jj-style diff3 write-back (`mergeStaleWrite`,
  `ConflictSurface`) already handles concurrent human/agent edits; it just needs a *shared*
  identity to fire against (gated to text via `merge_class`; binaries → hard-conflict, ties to
  the file-types `media_kind` work).

## 4. The keystone migration — `042_workspace_scoped_artifacts.sql`

The heart of the spec; the rest is wiring. Highest-2 next migration number is 041 → **042**.

1. **`artifacts`**: add `workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE`;
   **backfill** `workspace_id = sessions.workspace_id` via the existing FK (trivial — one join);
   then `SET NOT NULL`. Make `session_id` **nullable + `ON DELETE SET NULL`** (provenance of
   first author; the real author lives in `artifact_versions.author = 'agent:<session>'`).
   `channel_id` likewise → nullable provenance. **Swap the unique:** drop `UNIQUE(session_id,
   path)`, add `UNIQUE(workspace_id, path)`. No legacy duplicate-path preservation is required;
   installs are empty, and unexpected duplicate dev rows should fail loudly rather than be
   silently rewritten.
2. **`artifact_changes`**: add `workspace_id` (denormalized); add index `(workspace_id, xid,
   id)` for the workspace egress poll (keep the session index for per-session views); update the
   `artifact_changes_emit()` trigger to read+write `workspace_id` (`034:41-55`).
3. **`artifact_sync_state`**: same table shape, but all paths must be canonical artifact paths
   after resolving `~`/`shared` aliases (per-container state, not an ACL source).
4. **GC/reachability** (`036_artifact_blob_refs`, blob-GC): roots are now workspace artifacts,
   not session — verify the GC reachability walk no longer assumes session liveness.

## 5. Build lanes

Atrium = `master` fan-out. Centaur (Rust) = `gbasin/centaur fork/main`, gated default-OFF.
Each lane is a codex worker in an isolated worktree; Claude plans → reviews every diff
firsthand → merges (the established C4 cadence).

| Lane | Repo | Scope | Key anchors |
|---|---|---|---|
| **A — re-key migration** | Atrium | `042` migration + GC root check (§4); no legacy duplicate-path rewrite | `033`, `034`, `036`, `artifact-ledger.ts` |
| **B — shared read + workspace feeds** | Atrium | Re-key the ledger fns: `resolveOrCreateArtifactLocked`→`(workspace_id,canonical_path)` `ON CONFLICT`; `sessionScope` returns canonical paths in the session's workspace (`shared/...` + own `scratch/<session-id>/...`). `changesSince` uses a workspace cursor filtered to `shared/...` + own scratch. Hydration/changefeed responses include `activePrefix=shared/channels/<channel-id>` plus display/canonical path metadata so clients can present the active scope at `~`. `serveResolution`/`resolveVersion` read by workspace+canonical path. | `artifact-path.ts`, `artifact-ledger.ts`, `app.ts` |
| **C — shared/session write** | Atrium | Agent + human edits to a canonical path resolve to the **same** artifact → new version (base-aware OCC; diff3 on `mergeable-doc`, hard-conflict on `immutable-data`). Enforce prefix ACL on write: current code permits `shared/global`, the active channel, and own scratch; it rejects project/non-active channel prefixes until they have real ACLs. `scratch/<session-id>` is session-scoped, not a separate storage mechanism. | `artifact-writeback.ts`, `resolveOrCreateArtifactLocked`, `classifyScope` |
| **D — upload on-ramp (auto-land, §0.2)** | Atrium | Every human upload auto-creates a `shared/channels/<channel-id>/uploads/<name>` artifact, `author: human:<uid>`, pointing at the **same** CAS blob as the `files` row (zero-copy via server-verified `content_hash` → `cas_blobs`). Collision: sha-dedup identical; suffix-disambiguate different-bytes-same-name. Chat message pins `(artifact, seq)` for immutability. `files` stays as the ingest record. (Supersedes the old "explicit add / attachments stay separate" — see §0.2.) | `app.ts:1994-2074,2057-2070` (uploads), `2084` (channel write-back), `artifact-writeback.ts`, `classifyScope` |
| **E — Centaur subscription-set hydration = 5B-3, re-scoped** | Centaur | `http_client.rs` consumes the existing session-scoped internal routes and their `activePrefix`. **`hydrate_lower`** pulls canonical paths into the overlay RO lower as a CAS checkout after projecting local aliases: active shared prefix at `~` and also at `~/shared/channels/<active>` with the same base seq, own `scratch/<session-id>` at `~/scratch`, other shared scopes under `~/shared`. **Capture stays per-session** (`author=agent:<session>`; server resolves aliases to canonical paths). | `http_client.rs` |
| **F — Centaur live overlay + daemon wiring** | Centaur | Mount the overlay in the **live** controller (replace the `/workspace` EmptyDir); wire `nodeSync.enabled` + the multi-session flags the daemon currently ignores; inbound node-side merge (`agent-sync-design §4`). **Needs a real cluster** (the `c4-overlay-provisioning-plan.md` "Remaining" list); gated default-OFF; the in-agent poll stays the live path until cutover + parity. | `lib.rs:903`; chart `nodeSync.*` |

## 6. How this re-scopes 5B-3

5B-3 was "wire `hydrate_lower` for Atrium-CAS artifacts into the lower" — single-session.
Re-scoped, **5B-3 = lane E**: `hydrate_lower` pulls the **workspace subscription set**, not one
session's feed. The only added Centaur surface vs. the single-session version is *which
endpoint* it calls (`workspaces/{wid}` instead of `sessions/{id}`) and a subscription
path-filter — the materialize-the-lower mechanics (manifest → blob GET → tree) are identical.
So building lane B first means 5B-3 lands correctly-scoped the first time instead of being
rebuilt when workspace-sharing arrives. **5B-4** (node-local CAS cache + tree-manifest warm
tier, `agent-sync-design §5B` scale levers) is unchanged and rides after E.

## 7. Sequencing

```
A (migration) ─┬─> B (workspace ledger fns + node endpoints) ─┬─> E (5B-3 node hydration) ─> F (live cluster) ─> 5B-4 (warm cache)
               │                                              └─> C (shared write) ─> D (human on-ramp)
               └─ B is the hinge: E, C, D all need workspace-keyed reads/writes.
```
A → B are the load-bearing Atrium changes (and are independently shippable — they make the
ledger workspace-shared even before Centaur catches up). E is the teed-up Centaur build, now
correctly scoped. C/D deliver the human-visible product (co-edit + drop-a-file). F is the
real-cluster finish from the C4 plan. **Cutover (disable in-agent poll) stays deliberate and
last**, gated on parity (secret-scan / MIME filter).

## 8. Risks & decisions to confirm before fan-out

1. **Alias canonicalization** — active `~` and `~/shared/<same-leaf>` must never produce duplicate
   artifacts or duplicate `artifact_sync_state` rows. Atrium canonicalizes all ledger/sync-state
   ingress; Centaur projects `activePrefix` and own scratch to local paths before hydration/change
   adoption. Covered by unit + API tests.
2. **Reserved-name collision** — active-scope files named `scratch`, `shared`, `repos`, `context`,
   or dotdirs collide with mount roots/plumbing. The UI/import path must escape or disallow exact
   root-name collisions.
3. **Session-scratch retention** — scratch artifacts now surface in the GUI and outlive cold
   resumes; define retention and "promote to shared" UX. Do not hydrate another session's scratch
   by default.
4. **Session-cascade removal** — artifacts now outlive sessions → storage grows until blob-GC
   (already built) + a workspace-level retention policy. Confirm GC roots flip to workspace
   (lane A step 4).
5. **`channel_id` fate** — keep as nullable provenance, or drop? (Access now = workspace
   membership + path scope.) *Lean: keep nullable for "first created in" provenance + audit.*
6. **Non-active shared scopes** — decide which granted `~/shared/...` leaves are RW vs RO and
   whether broad scopes are materialized eagerly or accessed through search/read APIs. Current
   code only opens the active channel + `shared/global`; explicitly granted non-active leaves are
   future ACL work; large company-wide trees should be lazy/read-through.
7. **Upload→artifact byte path (lane D)** — uploads use a presigned *client* PUT, so the server
   never sees the bytes to hash; rely on a **server-verified** `content_hash` before trusting it
   for `cas_blobs` dedup (file-types §9.5 caveat), else re-hash on promote.
8. **Per-tenant blast radius (F)** — workspace-shared `/workspace` across containers raises the
   multi-tenant isolation bar; VM-per-tenant per the C4 remainder (#65).

## 9. Stress-test / UX walkthroughs (2026-06-25)

| Flow | Ergonomic behavior | Requirement / remaining hole |
|---|---|---|
| New non-repo task in a channel | Agent lands in `~`, runs `ls`, writes `report.md`; the server canonicalizes it to `shared/channels/<active>/report.md`. No agent prompt or taxonomy lesson. | Launch config must pass exactly one active shared prefix, and the Files UI should label it for humans. |
| Private draft / scratchpad | Agent writes `scratch/draft.md`; GUI/API shows it to humans authorized for that session; sibling agents do not hydrate it. | Define scratch retention, resume/fork lineage, and "promote/copy to shared" UX. |
| Human upload | Human drop becomes `shared/channels/<channel>/uploads/name` and appears at `~/uploads/name` for sessions in that active channel. | Upload UI must escape root-name collisions (`scratch`, `shared`, `repos`, `context`, dotdirs). |
| Browse wider context | Active leaf is eager at `~` and visible at `~/shared/channels/<active>`; `~/shared/global` can be hydrated when granted. Non-active channels/projects stay closed until Atrium has explicit ACLs for them. | Avoid eager hydration of broad company trees; prefer lazy/read-through for large scopes. |
| Code task | Agent may start in `~/repos/org/repo`; git owns repo edits, while durable deliverables still go through `~`, `~/scratch`, or an explicit shared alias. | Code-task GUI should make "save artifact/report" obvious so repo WIP is not mistaken for artifact persistence. |
| Alias path edit | Agent edits `~/report.md`; another tool edits `~/shared/channels/<active>/report.md`. | One canonical resolver must feed hydration, capture, writeback, and `artifact_sync_state`; otherwise duplicate chains appear. |

Weaknesses found: the model is ergonomic for a context-free agent only if Atrium, not the
agent, selects the active scope; `~` and `~/shared/<same-leaf>` canonicalization is the highest
implementation risk; scratch is artifact storage with narrower ACL, not a separate private file
system; and broad `shared/global` access should not be materialized by default.

## 10. Grounding

Atrium: `surface/server/migrations/{001,002,006,020,023,033,034,036}.sql`,
`src/{artifact-ledger.ts,artifact-writeback.ts,artifact-scope.ts,app.ts}`,
`web/src/sessions/FilesSurface.tsx`. Centaur (`fork/main @ ebdf762`):
`services/api-rs/crates/centaur-node-sync/src/http_client.rs`,
`centaur-sandbox-agent-k8s/src/lib.rs`. Mapped 2026-06-22.
