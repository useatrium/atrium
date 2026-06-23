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
> and `agent-sync-design.md` §2A/§4/§5/§5B (workspace-wide visibility; node-side merge;
> hydration = a CAS checkout of a subscription set).
> **What it unblocks:** the single shared `/workspace` where humans drop files and agents
> read **and edit** them like any artifact — and it **re-scopes Centaur 5B-3** from
> single-session hydration to a workspace-subscription set (lane E below).

---

## 0. CONVERGED DESIGN (2026-06-22 design session with Gary — canonical; supersedes the posture/path opens elsewhere)

Settled by walking real human + agent user stories. The test that drove every call:
*a context-free agent drops in, runs `ls`, and gets it — without learning a taxonomy.*

### 0.1 The agent's filesystem — flat home, few obvious roots
```
~  (= /home/agent; the agent WORKS HERE — writes are private by default, no name needed)
  shared/                ← the co-edited tree. ledger-backed artifacts, workspace-scoped.
    <channel>/           ← channel namespace
      uploads/           ← human-dropped files land here (their own subdir; raw inputs)
      <deliverables>     ← agent + human worked files
  repos/<repo>/          ← git checkouts. NOT artifact-synced (git owns them; cas-ledger §10.7).
  context/               ← READ-ONLY: chat transcripts + sibling sessions + ledger search.
                           (renamed from /atrium — "context" is self-evident to a no-context agent)
  .claude .codex .state  ← (hidden) harness/auth/state — never captured, outside any overlay
```
- **Private needs no name.** The agent writes where it lands (`~`); its files are private to the
  session. The only *named* dirs are the ones with non-obvious behavior (shared/repos/context).
- **Configurable landing.** The spawn sets CWD = `~` (general/deliverable task), `~/repos`, or
  `~/repos/<repo>` (code task). Same layout; only the entry point differs.
- **`context/` is words; `shared/` is files.** Read-only conversation vs editable artifacts — the
  cleanest split (an agent never wonders which folder a file is in: *all* files are in `shared/`).
- **Today's reality (grounded):** HOME=`/home/agent`; CWD=`~/workspace` (a per-session git clone);
  `.claude`→`state/claude` (auth+transcript), `.codex`→`state/codex` are symlinks into the
  persistent `state/` volume, already outside the captured tree. The `/workspace` mount + `/atrium`
  are the gated overlay path. This design replaces the per-session clone with the flat layout above.

### 0.2 Uploads / attachments → `shared/` by default (reverses file-types §9.5)
Every human drop lands as an editable artifact at **`shared/<channel>/uploads/<name>`** — no
"attachment limbo," no promotion step, no separate `~/uploads` (dropped as redundant). Agents
see + edit everything a human contributes, immediately (the original goal, fully realized).
- **Chat immutability via version-pinning:** the chat message references the pinned
  `(artifact, seq)` it was posted with, so editing the file later (v2, v3) never rewrites history.
  Editable file + immutable chat + one blob.
- **Collision rule:** identical bytes (same sha) → dedup to one artifact. Different bytes, same
  name → disambiguate like a Downloads folder (`screenshot.png`, `screenshot-2.png`) — never
  collapse two unrelated drops onto one version chain.
- **`files` table = ingest record** (presigned-PUT target + `content_hash`); the upload then
  creates the `shared/<channel>/uploads/` artifact pointing at the **same** CAS blob (zero-copy
  via server-verified `content_hash` → `cas_blobs`).
- **Subsumes a build piece:** uploads are ordinary shared artifacts → they ride the normal
  `hydrate_lower` path into the workspace; no separate "materialize attachment bytes" mechanism.

### 0.3 Default scope = PRIVATE, sharing is explicit (reverses cas-ledger §10.1)
The recorded §10.1 default ("workspace-wide shared by default") is **flipped to private-by-default**
on agent-UX grounds: a naive `report.md` must never collide with strangers' files. Sharing is the
deliberate act of writing into `shared/`. `(workspace_id, path)` identity (042) backs both: private
files = session-namespaced paths (`scratch/<session>/…`, enforced at capture); shared =
`shared/<channel>/…`. `classifyScope` carries the policy (the §10.8 through-line).

### 0.4 Build scope — what lands to master NOW vs. the Centaur follow-on
- **NOW (Atrium, landable to `master`, no cluster):** the server-side foundation — 042 identity +
  workspace-scoped ledger fns + shared write + the upload→`shared/<channel>/uploads/` on-ramp +
  `classifyScope` for the new layout + workspace-level read/hydration endpoints. Fully e2e-testable
  vs local PG:5433 + MinIO:9000. = **lanes A–D** below.
- **FOLLOW-ON (Centaur, needs a real cluster — picked up after):** the agent FS layout itself
  (flat home, `context/` rename, `shared/`/`repos/` mounts), subscription-set `hydrate_lower`
  (5B-3 = lane E), live overlay + daemon wiring (lane F). Tracked in `c4-overlay-provisioning-plan.md`
  + [[c4-overlay-capture-build]].

---

## 1. Goal

One product sentence (Gary): **a single shared workspace where humans drop files and agents
read and edit them like any artifact.** Two sessions in the same workspace see and co-edit
the same files; a human upload and an agent write land in the same namespace and version
chain; private scratch still exists. Scope is a **path prefix**, not a new column or tag
(`cas-ledger §10.1`).

This is "build the decided design," not a redesign. The design (`agent-sync-design.md §2A`,
"visibility = workspace-wide by default") is committed; the implementation is **session-siloed
on both repos today**.

## 2. Current state — strictly session-scoped silos (grounded 2026-06-22, both repos)

**Tenancy already supports the target** (this is what makes the migration cheap):
- `workspaces(id, name)` → `channels(workspace_id NOT NULL, …)` → `sessions(workspace_id NOT
  NULL, channel_id NOT NULL)` (`001_init.sql:19-31`, `002_phase2_sessions.sql:4-21`).
  **Every session already carries `workspace_id`** → the re-key backfill is a single join.
- `workspace_members(workspace_id, user_id)` is the membership gate (`023_workspace_members.sql`).
- `files` (human uploads) are **already workspace-scoped** (`workspace_id NOT NULL`, no session
  link, opportunistic `content_hash` dedup) (`006_files.sql`, `020_upload_content_hash.sql`).
- `classifyScope(path)` already maps prefixes → `private | topic | workspace`
  (`artifact-scope.ts`); used for **ACL only** today, reusable for **identity partitioning**.

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

- **Identity = `(workspace_id, path)`** (`cas-ledger §10.1`). `session_id`/`channel_id` demote
  to **nullable provenance**, not identity. Artifacts **outlive sessions**.
- **Scope folds into the path prefix** (reuse `classifyScope`, no new column):
  - `scratch/<session>/…` → **private** (session id is *in the path* → naturally unique; never
    shared, blind-append, zero merge cost).
  - `proj-x/…` / `topic/…` → **topic/team** scope (the realistic default altitude; co-edited,
    conflict-stated). Each task/agent gets a **default working dir** so collisions are
    structural, not accidental.
  - `shared/…` / root → **workspace-wide**.
- **Access follows scope**: anything past `scratch/` is gated by **workspace membership**
  (`workspace_members`), retiring channel-only `non-member→404` as the *sole* gate.
- **`artifact_sync_state` stays `(session_id, path)`** — it is the *per-container working-copy*
  base/upper state; each agent has its own `upper` even for a shared artifact. Correct as-is
  (`034_artifact_changefeed.sql:69-78`); its `base_seq` now points at a workspace-shared version.
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
   path)`, add `UNIQUE(workspace_id, path)`.
   - **Collision risk at backfill:** today two sessions in the same workspace *can* hold the
     same `path` (e.g. both wrote `report.md`) → they'd collide on the new unique. Mitigation:
     pre-migration, rewrite legacy non-`scratch/` paths to a per-session default prefix
     (`proj-<session8>/…`) so existing rows don't merge silently; `scratch/<session>/…` is
     already unique. (One-time; new writes land namespaced by the default-working-dir rule.)
2. **`artifact_changes`**: add `workspace_id` (denormalized); add index `(workspace_id, xid,
   id)` for the workspace egress poll (keep the session index for per-session views); update the
   `artifact_changes_emit()` trigger to read+write `workspace_id` (`034:41-55`).
3. **`artifact_sync_state`**: unchanged (per-container).
4. **GC/reachability** (`036_artifact_blob_refs`, blob-GC): roots are now workspace artifacts,
   not session — verify the GC reachability walk no longer assumes session liveness.

## 5. Build lanes

Atrium = `master` fan-out. Centaur (Rust) = `gbasin/centaur fork/main`, gated default-OFF.
Each lane is a codex worker in an isolated worktree; Claude plans → reviews every diff
firsthand → merges (the established C4 cadence).

| Lane | Repo | Scope | Key anchors |
|---|---|---|---|
| **A — re-key migration** | Atrium | `042` migration + collision rewrite + GC root check (§4) | `033`, `034`, `036`, `artifact-ledger.ts` |
| **B — shared read + workspace feeds** | Atrium | Re-key the ledger fns: `resolveOrCreateArtifactLocked`→`(workspace_id,path)` `ON CONFLICT`; `sessionScope`→`workspaceScope(workspace_id, sessionId)` returning **workspace-shared paths ∪ this session's `scratch/`** (the subscription set); `changesSince`→workspace cursor; `serveResolution`/`resolveVersion` by workspace. New routes `GET /api/internal/workspaces/:wid/artifacts/{changes,raw}` + `…/hydration-scope?session=` for the node; keep session routes as scoped views. | `artifact-ledger.ts:207,335,397,505,742`; `app.ts:2717,2792,2899,3129,3275` |
| **C — shared write** | Atrium | Agent + human edits to a workspace path resolve to the **same** artifact → new version (base-aware OCC; diff3 on `mergeable-doc`, hard-conflict on `immutable-data`). Enforce path-prefix scope on write (scratch stays private/blind-append). | `artifact-writeback.ts`, `resolveOrCreateArtifactLocked`, `classifyScope` |
| **D — upload on-ramp (auto-land, §0.2)** | Atrium | Every human upload auto-creates a `shared/<channel>/uploads/<name>` artifact, `author: human:<uid>`, pointing at the **same** CAS blob as the `files` row (zero-copy via server-verified `content_hash` → `cas_blobs`). Collision: sha-dedup identical; suffix-disambiguate different-bytes-same-name. Chat message pins `(artifact, seq)` for immutability. `files` stays as the ingest record. (Supersedes the old "explicit add / attachments stay separate" — see §0.2.) | `app.ts:1994-2074,2057-2070` (uploads), `2084` (channel write-back), `artifact-writeback.ts`, `classifyScope` |
| **E — Centaur subscription-set hydration = 5B-3, re-scoped** | Centaur | `http_client.rs`: add workspace-scoped calls (`/api/internal/workspaces/{wid}/artifacts/{changes,raw}` + `hydration-scope?session=`); node config gains `workspace_id` + the subscription path-prefixes alongside `session_id`. **`hydrate_lower`** pulls the **subscription set** (workspace-shared ∪ own `scratch/`) into the overlay RO lower as a CAS checkout (`agent-sync-design §5B`: manifest → per-path blob_sha/chunk-manifest → S3 GET → materialize tree). **Capture stays per-session** (`author=agent:<session>`; server resolves to the shared artifact). | `http_client.rs:32-37,118,148`; the 5B daemon |
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

1. **Backfill collision (§4.1)** — the one-time path rewrite for legacy same-path rows. Confirm
   the rewrite rule (per-session `proj-<id8>/` prefix) vs. last-writer-wins merge. *Lean: rewrite
   (no silent data merge).*
2. **Session-cascade removal** — artifacts now outlive sessions → storage grows until blob-GC
   (already built) + a workspace-level retention policy. Confirm GC roots flip to workspace
   (lane A step 4).
3. **`channel_id` fate** — keep as nullable provenance, or drop? (Access now = workspace
   membership + path scope.) *Lean: keep nullable for "first created in" provenance + audit.*
4. **Default working dir** — who assigns `proj-x/`? (runtime per task vs. agent convention).
   Needed so concurrent tasks don't collide on root paths.
5. **Upload→artifact byte path (lane D)** — uploads use a presigned *client* PUT, so the server
   never sees the bytes to hash; rely on a **server-verified** `content_hash` before trusting it
   for `cas_blobs` dedup (file-types §9.5 caveat), else re-hash on promote.
6. **Per-tenant blast radius (F)** — workspace-shared `/workspace` across containers raises the
   multi-tenant isolation bar; VM-per-tenant per the C4 remainder (#65).

## 9. Grounding

Atrium: `surface/server/migrations/{001,002,006,020,023,033,034,036}.sql`,
`src/{artifact-ledger.ts,artifact-writeback.ts,artifact-scope.ts,app.ts}`,
`web/src/sessions/FilesSurface.tsx`. Centaur (`fork/main @ ebdf762`):
`services/api-rs/crates/centaur-node-sync/src/http_client.rs`,
`centaur-sandbox-agent-k8s/src/lib.rs`. Mapped 2026-06-22.
