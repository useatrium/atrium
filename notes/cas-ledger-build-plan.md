# CAS-ledger — full design + build plan

> **STATUS (2026-06-20): v1 MERGED to `master`** (PR #35 = `aeb4e9f`; pushed to
> origin). Foundation + all 4 codex lanes merged + reviewed; **full suite green,
> 242 tests** (local Postgres 16 on :5433). Built: mig 033 ledger, `ArtifactLedger`
> core, capture-bridge + CAS re-key, serve-latest-by-path, write-back PUT +
> node-diff3 conflict-state, blob-GC worker + C1 NOTIFY/changed-since hooks.
> **Verified live (2026-06-20):** the Atrium half on real PG+MinIO (write-back /
> serve / presigned-fetch / diff3 conflict round-trip) AND the **full
> capture→offload→serve chain on the real `centaur` kind cluster** — drove a real
> session+capture, the bridge created the ledger version from a real producer
> frame, offload re-keyed to `cas/<sha>`, serve-by-path returned the bytes (match).
> **Deferred:** client-side gallery by-path reducer view; version-chain compaction
> (only blob-GC this round). **C2 overlay DROPPED** (sandbox can't mount: non-root/no-caps);
> **C3 large-file** needs Centaur object store (16 MiB ceiling today); **C1
> inbound-sync** is the next Centaur effort (`notes/inbound-sync-spec.md`).
>
> **DESIGN PASS 2026-06-19, clarified 2026-06-25 (see §10):** identity went
> **workspace-scoped** (`(workspace, canonical_path)`, scope as a reserved path prefix).
> Active shared work is materialized at `~`; session scratch lives under
> `scratch/<session-id>/...` with the same artifact machinery and a narrower ACL.
> **notes → artifact-canonical** (reverses daily-driver §2); **C1 live inbound now IN
> SCOPE**; autonomous reconcile = **auto-rebase**; **diff3 gated by merge-class**;
> **code repos excluded from sharing** (git owns them).
>
> **STORAGE SIMPLIFICATION 2026-06-25:** implementation = **one Atrium CAS write path**.
> Agent capture, human write-back, upload auto-land, hydration, and app publish all
> reference `cas_blobs`; a non-delete committed version must point at bytes already
> durable in S3. `session_artifacts` is deleted along with the Centaur-proxy/offload
> artifact path. This supersedes the older §3b-§3d
> "keep `session_artifacts` as staging" plan below.


The durable artifact CAS-ledger decided in `spike-artifact-store.md` (own
CAS-ledger over lakeFS, 39–29), planned inside the bigger picture it lives in:
workspace execution, capture, durable versioning, and no-ingress sync. Companion
to `agent-data-architecture.md` (the deep design) and §3 of
`atrium-daily-driver-plan.md` (where this is the storage substrate). Written
2026-06-19, after a stress-test + hand-compute pass.

## 0. The three planes (where the ledger sits)

```
EXECUTION (in sandbox, Centaur)        DURABLE (Atrium)               SYNC (egress-only, no-ingress)
  /workspace = overlay merged            cas_blobs  (S3, global)        OUT: hydrate-GET at start
   lower = base+deps+hydrated (RO)       artifacts  (PG, (workspace,path))    capture-POST  (durable CAS first)
   upper = agent edits (RW) ── diff ──►  artifact_versions (chain)      IN : lazy pull-on-access  ┐ NEW
  artifact_capture.py (2.5s poll) ──────►artifact_pointers (latest…)         invalidation/subscribe┘ Centaur work
```

**The ledger (middle column) is the only part we build now.** The execution
overlay and the inbound-sync channel are Centaur runtime work, sketched here
(§4/§5) because the ledger is their prerequisite — but they are **not** in this
build.

## 1. Confirmed facts (grounded this session, not assumed)

- **Capture cadence = a 2.5 s polling watcher.** `services/sandbox/
  artifact_capture.py` (on `atrium/integration`) is `while True: scan_once();
  sleep(ARTIFACT_CAPTURE_INTERVAL_S=2.5)`. It walks allow-listed dirs
  (`ARTIFACT_CAPTURE_DIRS`), captures any file whose mtime/size changed past the
  junk/secret/size filters. Continuous, change-driven, **best-effort**. ⇒
  **Capture is a fine-grained working-history feed, not a promote signal.**
- **Frame shape** (`centaur-client/src/types.ts:275`): `artifact_id` (=content
  hash, changes every edit), `path`, `kind: created|modified|deleted`, `mime`,
  `size_bytes`, `sha256`, `ref` (Centaur staging key, null=manifest-only),
  `execution_id`. **No stable file-id, no `old_path`** → renames are invisible.
- **Producer is merged** into `atrium/integration` (deploy/running status not
  verified). Atrium-side capture/offload/serve are on `master`.
- **Sessions are always in a channel** (`sessions.channel_id NOT NULL`, mig 002);
  DMs are channels too (mig 007). `session → channel` is total.
- **Diffs already exist** as a separate axis: the "Changes" surface is derived
  from harness edit tool-calls (`fileChange`/`changes[].{path,kind,diff}`),
  independent of artifact capture (`centaur-client/src/artifacts.ts:3`).
- **Conflict-state is buildable**: `node-diff3@3.2.1` POC-confirmed — git-style
  `<<<<<<< ||||||| ======= >>>>>>>` markers with custom labels + structured
  `{a,o,b,index}` chunks; suppresses false conflicts (identical edits stay
  clean); trailing-newline safe. *Caveat:* adjacent independent edits conflict
  (standard diff3 conservatism) — design the resolve UX for "conflicts happen."
- **Reusable infra (master):** `s3.ts` (`uploadObject`/`presignGet`/`presignPut`),
  the 302-redirect serve route shape, and the CAS ledger primitives. The older
  `artifact-offload.ts`/`session_artifacts` path is proven but superseded by the
  single-CAS hard cut. Migrations are sequential → **next = `033`** (this repo
  has no upstream; the `1000+` rule is the api-rs fork's, not surface/server's).
- **Consumer requirement (Gary):** always-latest is fine → **v1 pointer = `latest`
  only**; `official`/pin/promote are later.
- **Centaur runtime (mapped this session, `centaur-wt/integration`):**
  - Sandbox workspace = a per-session **`git clone --shared`** into emptyDir (or a
    PVC if `CENTAUR_PERSISTENT_STATE=1`) — **no overlay today**
    (`services/sandbox/entrypoint.sh:336`).
  - Capture runs **in-process** — the entrypoint backgrounds `artifact-capture`,
    it is **not** a sidecar container (`entrypoint.sh:427`); context via env +
    downward-API `/etc/centaur/runtime-context`.
  - Bytes stage in a **Postgres `artifact_blobs` table** (`1000_artifact_blobs.sql`,
    `data bytea`), **only if ≤ ~1 MiB** (`ARTIFACT_CAPTURE_MAX_BYTES`; larger =
    manifest-only, no bytes), retained for the **execution lifecycle** (cascade
    delete). ⇒ **large artifacts have no servable bytes until Centaur raises the
    cap** — an Atrium-side multipart story is moot until then.
  - A running agent receives input **only via stdin through the k8s `attach`
    pipe** (control-plane push; `centaur-session-runtime` `write_input_lines`) —
    **there is no held outbound subscribe stream.** This *corrects the design
    doc*: inbound invalidation must be a **new stdin directive**, not "ride the
    outbound stream" (see §5).
  - **No startup rehydration** (always a fresh clone); **no-ingress confirmed**
    (default-deny ingress, egress to api-rs only).

## 2. The model (final, after the design conversation)

| Table | Key | Holds |
|---|---|---|
| `cas_blobs` | `sha256` | global content-addressed bytes → S3 (`s3_key` present before any non-delete version commits) |
| `artifacts` | `id` uuid, `UNIQUE(session_id, path)` | logical artifact identity (+ denormalized `channel_id`, `merge_class`) |
| `artifact_versions` | `(artifact_id, seq)` | chain: `blob_sha`, `base_seq`, `author`, `kind`, `status`, `conflict` |
| `artifact_pointers` | `(artifact_id, name)` | movable refs; v1 ships only `latest` |

**Three load-bearing ideas, settled:**
- **Capture is the version *feed*; promotion is a *pointer*.** They're different
  layers. Promotion (later) ingests no bytes — it just advances a label
  (`official`/pin/channel-ref) to a version capture already made. "Aged-ness =
  which pointer you follow."
- **The ledger is cadence-agnostic.** Today's 2.5 s watcher fills the chain
  densely; a future overlay+daemon would fill it differently — same schema. We
  must not *assume* the cadence, only store what arrives.
- **Identity = `(session_id, path)`** (channel denormalized for access + future
  sharing). Session-scoped avoids agents colliding on generic names
  (`report.md`); cross-session sharing is the deliberate later promotion layer.
  Content-dedup on `(path, sha)` makes re-captures idempotent (2.5 s mtime-touch
  with unchanged bytes ⇒ no new version). Renames break the chain (no producer
  signal) → lineage stitches provenance later; pins to the old path keep
  resolving (immutable blobs). Code renames are git's job (`.git` is
  capture-ignored), so this only bites non-code artifacts.

## 3. Build — the substrate (Atrium-side, now)

### 3a. Migration `033_artifact_ledger.sql`

```sql
CREATE TABLE IF NOT EXISTS cas_blobs (
  sha256     text PRIMARY KEY,
  s3_key     text,                                   -- target: NOT NULL before any non-delete version commits
  size_bytes bigint      NOT NULL,
  mime       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,   -- denormalized for access/sharing
  path        text NOT NULL,
  merge_class text NOT NULL DEFAULT 'immutable-data',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, path),
  CHECK (merge_class IN ('immutable-data','mergeable-doc','derived-output'))
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  seq         int  NOT NULL,
  blob_sha    text REFERENCES cas_blobs(sha256),     -- NULL only for a delete tombstone
  base_seq    int,
  author      text NOT NULL,                         -- 'agent:<session>' (capture) | 'human:<uid>' (later)
  kind        text NOT NULL,                         -- created | modified | deleted
  status      text NOT NULL DEFAULT 'normal',        -- normal | conflict (later)
  conflict    jsonb,                                 -- both-sides payload (later)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, seq),
  CHECK (kind IN ('created','modified','deleted')),
  CHECK (status IN ('normal','conflict')),
  CHECK (kind = 'deleted' OR blob_sha IS NOT NULL),
  CHECK (base_seq IS NULL OR base_seq < seq)
);

CREATE TABLE IF NOT EXISTS artifact_pointers (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name        text NOT NULL,                         -- v1: only 'latest'
  seq         int  NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, name),
  FOREIGN KEY (artifact_id, seq) REFERENCES artifact_versions (artifact_id, seq)
);
```

### 3b. Capture ingest (hard-cut target — single CAS path)

All artifact byte producers write through Atrium's CAS capture/write-back path
before a version is committed:

1. Agent capture calls the internal Atrium capture endpoints directly:
   `/api/internal/sessions/:id/artifacts/capture` for buffered files and
   `/capture-stream` for large files. The session route remains the right internal
   surface because capture is session-authored and the server already resolves the
   active-prefix alias to a workspace-scoped canonical path.
2. Human write-back and upload auto-land reuse the same invariant: write or point
   at durable CAS bytes first, then insert/update `cas_blobs` with `s3_key`, then
   commit `artifact_versions`.
3. Delete captures commit a tombstone (`blob_sha NULL`) and never touch blob
   storage.
4. The old `artifact.captured` event bridge stops being a storage ingress. If a
   transcript/event needs to show "artifact captured," it is emitted or projected
   from the ledger commit, not used as the source of truth for bytes.

The key invariant is simple enough to test globally: **no non-delete
`artifact_versions` row points at a `cas_blobs` row whose `s3_key` is NULL**. A
missing `s3_key` is an invariant violation/backfill defect, not a normal pending
state.

### 3c. Delete `session_artifacts`, don't replace it

`session_artifacts` bundled four jobs: legacy gallery identity,
temporary Centaur byte source, offload queue/lease, and S3 status mirror. In the
hard-cut implementation each job has a cleaner owner:

- identity/version/path → `artifacts` + `artifact_versions` + `artifact_pointers`;
- durable bytes → `cas_blobs.s3_key`;
- capture queuing/offload → none for artifacts, because the producer writes CAS
  before commit;
- legacy gallery rows → removed with the by-id gallery route/client reducer.

The hard-cut branch deletes the Atrium mirror row (`recordArtifact`), artifact offload
worker path (`offloadArtifactBatch` / `offloadOneArtifact`), Centaur artifact
proxy fallback, `session_artifacts` migrations/table references, and the env/docs
that make artifact offload a production worker. Centaur's old staging table and
artifact byte routes are removed by the Centaur hard-cut migration; node-sync/direct
Atrium capture is the production capture path, not an Atrium dependency.

No transitional blob-source/outbox is in scope for the target implementation. If
production capture is not on node-sync/direct Atrium capture yet, finish that
cutover first rather than preserving a second artifact byte path.

### 3d. Serve-latest route

`GET /api/sessions/:id/artifacts/by-path?path=…` resolves the session-visible path
through the active-prefix canonicalizer, then resolves `(workspace,path)` →
`latest` → version → `blob_sha` → `cas_blobs.s3_key`. Non-delete versions serve
from S3/CAS only: presigned **302** for browser reads, or server-side S3 fetch for
internal raw/hydration routes. `latest.kind='deleted'` returns **410 Gone**.

There is no Centaur proxy fallback. If a non-delete version lacks `s3_key`, return
`503 blob_unavailable` (and alert/metric), because the writer broke the
durable-before-commit contract. The legacy per-`artifactId` route is removed in
the coordinated client cut; the gallery follows the by-path/current-version view.

### 3e. Tests
1. capture v1 → `latest=1`, serve-by-path → v1 bytes.
2. capture same path new content → `latest=2`; old seq still resolvable.
3. content-dedup: re-capture identical bytes → no new version (idempotent).
4. global blob dedup: same sha across two artifacts → one S3 PUT, one `cas_blobs`.
5. `kind=deleted` → tombstone version, serve-by-path → 410.
6. invariant guard: non-delete version with missing `s3_key` → `503
   blob_unavailable` + metric; normal reads never proxy.
7. channel access gate (non-member → 404, no existence leak).
8. blob-insert race → `ON CONFLICT DO NOTHING`, no duplicate-key error.
9. hard-cut cleanup: no `session_artifacts` rows, worker claims, or Centaur
   artifact proxy calls are required for a fresh capture to serve.

## 4. Execution plane — workspace layout (context; Centaur-side, NOT in this build)

The eventual execution model (design, `agent-data-architecture.md`):
- **`/workspace` = an overlayfs merge** — `lower` = base image + deps + hydrated
  shared artifacts (read-only); `upper` = this agent's writes (private). A write
  to a shared artifact **copies-up** into `upper` (never EROFS; base immutable);
  **`upper` is the diff** (free capture, structurally excludes deps).
- **In-container footprint = a sync daemon + git** — watches `upper`, egress-POSTs
  captures, holds the outbound subscribe stream, lazy-pulls on access; `git` runs
  on top for code (canonical to the forge). **No jj/VCS engine in the sandbox;
  not object-FUSE/Archil** (FUSE dies on atomic rename / lockfiles / fsync).

**Today's reality:** there is no overlay yet — `artifact_capture.py` just polls
allow-listed dirs in whatever the sandbox FS is. **The ledger does not depend on
the overlay**; it ingests capture frames regardless of FS structure. Overlay is
the future execution upgrade; building it does not block the ledger, and the
ledger does not block agents from working today.

## 5. Sync plane — how updates propagate under no-ingress (context + the dependency edge)

Centaur sandboxes are **no-ingress** (nothing dials *in*) → all sync is
sandbox-initiated **egress**:
- **Hydrate-GET at startup** — sandbox pulls its workspace from the durable store.
- **Capture-POST** — the 2.5 s watcher pushes out (**built**).
- **Mid-session inbound** (a human / other agent edited a shared artifact while a
  sandbox runs) — there is **no push in**:
  - **lazy pull-on-access** — the daemon GETs the current version when the agent
    next reads the file;
  - **invalidation as a new stdin directive** — *corrected from the design doc by
    the Centaur map:* a running agent's only inbound channel is **stdin via the
    k8s `attach` pipe** (control-plane push); there is **no** held outbound
    subscribe stream to ride. So "artifact X advanced" must be a **new stdin
    message type** (e.g. `{"type":"artifact.sync", path, sha}`) that api-rs writes
    to the sandbox; the harness handles it and GETs the bytes. Cross-system flow:
    Atrium ledger advances → notifies api-rs → api-rs pushes the stdin directive →
    harness pulls + writes the file. Scoped as **Track C1** below.
  - Reconcile **at promote** in the ledger (fork → conflict-state). Never
    hot-swap a file under a running agent — notify, it decides to rebase.

**The dependency edge that makes this build matter:** mid-session inbound sync is
**new Centaur work** and is the **gating item for live cross-container
collaboration** — but it is **downstream of this ledger**. The ledger is the
authoritative version source the daemon would pull from, and `LISTEN/NOTIFY` (or
an outbox) on `artifact_pointers`/`artifact_versions` writes is the invalidation
source. So: **build the ledger now → it unblocks inbound sync later.** Until
inbound sync exists, cross-container freshness = "you find out at your next
hydrate/restart." (Single-agent + human-gallery use — the daily-driver v1 — is
fully served without it.)

## 5b. Centaur-side scope (separate tracks, grounded in the repo map)

These are **runtime work in `centaur-wt/integration`, not in this Atrium fan-out**
— scoped here so the build-boundary decision is made with the full picture. Both
are largely **independent of the ledger build** (the ledger ingests capture
frames regardless), and C1 is **downstream of** the ledger (needs it as the
version source).

### Track C1 — Mid-session inbound sync (the gating item for live collab)

Goal: a human/other-agent edit reaches a **running** sandbox. The map shows the
real mechanism is **not** "ride an outbound stream" — it's a **push down stdin**:
1. **Atrium → api-rs notify.** When the ledger `latest` advances for an artifact
   whose `(session)` has a live execution, Atrium calls api-rs (api-rs is
   reachable; Atrium isn't no-ingress). New small Atrium emitter + an api-rs
   receive route.
2. **api-rs → sandbox stdin directive.** api-rs maps session → running execution
   and writes a new framed stdin line `{"type":"artifact.sync", path, sha}` via
   the existing `write_input_lines`/attach path (`centaur-session-runtime`).
3. **Harness handler.** The in-sandbox harness handles the directive, **GETs the
   bytes** (api-rs proxies from Atrium's S3, or Atrium pre-stages into
   `artifact_blobs`), and writes to a **staging path** — never hot-swapping the
   file under the agent (notify-then-rebase, per the no-hot-swap rule).
**Effort drivers / risks:** the harness must grow a directive handler (per-harness:
codex/claude/amp); ordering is at-least-once (Postgres `LISTEN/NOTIFY` + a ~30 s
safety poll → up to 30 s catch-up latency unless tuned); api-rs needs a
session→execution→stdin route + a byte-proxy (or Atrium push into staging). This
is the meatiest piece and is correctly the **"new Centaur work" gate**; until it
ships, cross-container freshness = at next hydrate/restart.

### Track C2 — Overlayfs per-agent execution workspace — **DROPPED (stress-tested 2026-06-19)**

> **Reframed 2026-06-20 → see Track C4.** C2 = *the agent mounts its own overlay*,
> which stays correctly dropped (no `CAP_SYS_ADMIN` in the hardened sandbox). **Track
> C4 relocates the privilege**: the *runtime/node* sets up the overlay and a *node*
> scanner reads the upper — the agent never mounts anything and stays hardened. The
> C2 drop reasoning below is right for the agent-mount framing; it does not bind C4.

**Verdict: infeasible as specced; do NOT build the in-container overlay mount.**
The make-or-break fails: the agent sandbox runs **non-root, `drop:[ALL]` caps,
`allowPrivilegeEscalation:false`, RuntimeDefault seccomp**
(`centaur-sandbox-agent-k8s/src/tools.rs:109-118`). An overlay mount needs
**CAP_SYS_ADMIN** → `EPERM`. The only escape (userns + namespaced CAP_SYS_ADMIN)
is a deliberate security-posture regression for a sandbox that exists to isolate
untrusted agents, **and is likely blocked at the node kernel on GKE COS**
(`CONFIG_SECURITY_CHROMIUMOS_NO_UNPRIVILEGED_UNSAFE_MOUNTS`).

The claimed payoffs also don't hold up:
- **"Upper IS the diff / free capture" is already ~90% delivered** — the watcher
  prunes dirs + skips unchanged files via an mtime/size cache
  (`artifact_capture.py:160-168, 251-272`); overlay would only shave a walk to a
  constant factor *and* add whiteout/opaque-dir parsing.
- **The hardlink-copy-up fear rested on a false premise** (ours): `git clone
  --shared` uses **alternates**, not hardlinks (`--local` uses hardlinks). No
  hardlink farm to break.
- **upper can't live on the overlay container-rootfs**; CSI/PVC-as-upperdir is a
  known minefield (NFS unsupported; k3s#4769).
- **The upper is destroyed on every Pause** — pause = `spec.replicas:0` deletes
  the pod (`lib.rs:512-524`); no CRIU; only the state PVC survives.

**The cheap alternative that delivers the same insight:** the workspace is
**already a git clone** (`entrypoint.sh:351`), so `git status --porcelain` + `git
diff` over the session branch *is* the changed-set — no mount, no caps, already
excludes `.git`/ignored. If we ever want "diff-for-free + base-exclusion" beyond
what the watcher gives, that's the no-privilege path. **Mark the privileged
overlay model in `agent-data-architecture.md` as superseded by this finding.**
None of this blocks the ledger or the daily-driver v1 (capture works on the plain
clone today).

### Track C4 — Overlay-upper capture via a node-level scan — **DECIDED target capture architecture (2026-06-20)**

The scalable/permanent replacement for the in-container 2.5s poll. Stress-tested +
hand-computed 2026-06-20 (codex review attempted, runtime non-functional — verdict
is from the in-house pass; its research trail corroborated the mountPropagation,
torn-read, and hostPath risk points). **Decided as the target. Kernel mechanism
POC-CONFIRMED 2026-06-20** (9/9, below) on the **real `centaur-agent` image, kernel
6.12.76-linuxkit**. **AND the k8s wiring is now CONFIRMED too** — a second agent ran
the full kind end-to-end POC (privileged init mounts the overlay `Bidirectional` onto
a hostPath; hardened agent UID-1001/`drop:[ALL]`/`seccomp:RuntimeDefault` mounts it
`HostToContainer` and writes through `merged`; node verified bytes in `upper`,
copy-up, whiteout `char 0:0`, mount `shared`). **Both halves PASS; no residual kernel
or k8s-wiring unknown.** The one correction it surfaced is folded into the propagation
bullet above (agent = `HostToContainer`, not `Bidirectional`).

**POC result (2026-06-20, privileged Linux container on the agent image, 9/9 PASS):**
privileged overlay mount works (`metacopy=off`); create→upper regular file w/ bytes;
modify-lower→**full** copy-up bytes; delete→**whiteout char-dev 0/0**; **non-root
uid-1001 agent writes via `merged` → root "node" reads them from `upper`**; **a
process in a separate mount namespace writing via `merged` → node sees it in `upper`
(the agent-in-own-ns linchpin)**; the `merged` mount is **visible across mount
namespaces via `rshared`**; rename resolves. ⇒ The kernel feasibility that could
have killed the design — can a hardened non-root agent's writes, through a
runtime-mounted overlay it doesn't own, land in an `upper` a node component reads? —
is **confirmed**. *Residual (now small):* (a) ~~k8s wiring~~ **CONFIRMED in kind**
(privileged-init `Bidirectional` + agent `HostToContainer`); remaining ops detail =
the init-mounted overlay propagates to and **persists on the node** after the init
exits, so **unmount-on-pod-teardown** must be handled (else orphaned node mounts); (b)
rename via `trusted.overlay.redirect` xattr read needs `attr`/`CAP_SYS_ADMIN` (POC
couldn't read it; rename still resolves by path → fidelity falls back to
path+whiteout); (c) POCs used tmpfs backing — real design uses a node ext4/hostPath
vol (identical mechanism; ext4 also stores trusted xattrs; avoids the nested-overlay
backing error seen on tmpfs-less kind).

**The shape.** Move capture *out* of the agent; relocate privilege to the
runtime + a node component (we control the node — self-managed k8s on dedicated
servers, no Autopilot):
- **Workspace = a runtime-provisioned overlay** (privileged init/controller, NOT the
  agent): `lowerdir` (RO) = base + deps + **repo (clone --shared, read-only)** +
  hydrated shared artifacts; `upperdir`+`workdir` = a **session-keyed persistent
  node volume** `/var/lib/centaur/overlays/<session>/{upper,work}` (a **hostPath** —
  not the container rootfs / not a nested overlay); `metacopy=off` (so upper files
  carry real bytes). **Propagation (CORRECTED — k8s POC):** the **privileged setup**
  (an init container is sufficient) mounts the overlay with
  `mountPropagation: Bidirectional`, which propagates the mount to the node and
  persists it there after the init exits; the **hardened agent** mounts the same
  hostPath at `/workspace` with **`mountPropagation: HostToContainer`** (rslave) to
  *receive* it — k8s **forbids `Bidirectional` on a non-privileged container**
  ("available only to privileged containers"). Agent posture **unchanged** (non-root,
  `drop:[ALL]`).
- **Capture = a node DaemonSet** (privileged; **one per node = O(nodes)**): k8s pod
  informer → scan each `<session>/upper` (the upper = **only the changed set =
  O(changes)**), prune git working trees at the `.git` root + the existing
  junk/secret filters; interpret overlay encoding (regular file → created/modified;
  **char-dev 0/0 → delete**; `trusted.overlay.redirect` → **rename**;
  `trusted.overlay.opaque` → opaque); read bytes, hash, **POST direct to Atrium S3**
  (the node is trusted infra, not bound by the sandbox egress NetworkPolicy → big
  files bypass the `bytea` 1 MiB/16 MiB wall → **closes C3 in the same design**); map
  `session` via the `centaur.ai/{thread-key,execution-id}` annotations. The scan **is**
  the reconcile sweep (state diff → complete, no event-drop window).
- **The in-container poll is retired** for the target environment. A future
  managed-restricted node that cannot run privileged DaemonSets/overlay setup would
  need a separate capture design rather than reviving Centaur staging.

**Why this is the permanent scalable shape:** O(changes) scan (no `max_user_watches`
ceiling, no full-tree walk) **and** O(nodes) scanner (scales with pod density, not
per-pod) — the only mechanism that scales on *both* axes while keeping the agent
fully hardened. Plus delete/rename fidelity the poll never had, zero in-agent
footprint, and a native large-file path.

**The four commitments it forces (hand-compute, 2026-06-20):**
1. **Repo in the RO lower, not cloned into the writable workspace** — else the
   `git clone` lands in the upper and bloats it to repo-size (the scan would prune it
   but the bytes still sit there). Repo-in-lower keeps the upper = genuine changes.
   (A Centaur provisioning change, not a drop-in.)
2. **Torn reads are NOT auto-solved** by a state-scan (no `FAN_CLOSE_WRITE`-style
   signal). Real backup/sync tools (rsync temp-file+atomic-rename + "modified during
   transfer"; restic "file changed during backup") gate this via **detect-changed-
   during-read → re-read**, plus the node scanner can **inspect `/proc/<agent-pid>/fd`
   and skip files currently open for write**. Combine both.
3. **Session-keyed persistent upper** (hostPath/PVC, keyed by session not pod-uid) so
   it survives pause (= pod delete) and **resume reattaches** the same upper — which
   also upgrades resume from "fresh re-clone" to "prior state restored."
4. **The mount-propagation linchpin — FULLY POC-CONFIRMED (2026-06-20), kernel +
   k8s.** The question (*can a hardened non-root agent's writes, through a
   runtime-mounted overlay it doesn't own, land in an `upper` a node component
   reads?*) is **yes**, proven end-to-end: the bare-kernel POC (9/9) + a **kind k8s
   POC** (privileged init mounts the overlay `Bidirectional` onto a hostPath; the
   hardened agent — UID-1001, `drop:[ALL]`, `seccomp:RuntimeDefault` — mounts it
   **`HostToContainer`** and writes through `merged`; node verified `upper` bytes,
   copy-up, whiteout, `shared` mount). **The correction it forced:** k8s **forbids
   `Bidirectional` on a non-privileged container** — so the *setup* uses
   `Bidirectional`, the *agent* uses `HostToContainer` (folded into the provisioning
   bullet above). No longer a risk; remaining is the unmount-on-teardown ops detail.

**Multi-tenant blast radius → VM-per-tenant (decided 2026-06-20).** The node
DaemonSet reads every pod's files on its node — a real cross-tenant read surface.
Software-scoping (a per-tenant DaemonSet that only attributes its own pods) is weak
(it still holds node-root). The right boundary is a **VM**: each tenant in its own
VM = its own k8s node (microVMs — Firecracker/Cloud Hypervisor — for density), pods
pinned per tenant → the per-node DaemonSet is **structurally per-tenant**, and the
hypervisor makes cross-tenant read **hardware-impossible**, not policy-disallowed.
Inside the VM we also fully own the kernel (overlay/`mountPropagation`/caps
guaranteed). This is a **future concern** (daily-driver is single-tenant) and
**orthogonal to the capture design** — it only sets where the node boundary falls.

**Inbound complement + workspace composition:** C4 is the outbound/capture half. The
unified inbound+outbound sync design — node-side fetch+stage, in-container checkpoint
adopt, the hydration manifest, and the **structural workspace scoping** (overlay covers
*only* the artifact namespace; repos/deps/caches/scratch are separate volumes so they
never enter the upper → solves capture-filtering + upper-bloat by construction) — is in
**`agent-sync-design.md`** (supersedes the in-container `inbound-sync-spec.md`).

### Track C3 — Large-file handling (spec'd + stress-tested 2026-06-19)

**Finding: the Centaur fork has NO large-file handling, and no object store at
all** (the only AWS refs are iron-proxy SigV4 cred-injection + a read-only
CloudWatch client — verified by two independent traces). Bytes are
**whole-in-memory at every hop**: the sandbox reads in 1 MiB chunks *for hashing*
but `b"".join(chunks)` re-buffers the whole file and POSTs one in-memory blob;
api-rs `field.bytes()` buffers the whole multipart field; storage is `bytea`;
serve is `Body::from(blob.data)` (the SPEC claims streaming — **aspirational, the
code buffers**). Retention = execution-lifetime.

**Trace (today):**
- **5 MB file** → blocked at the 1 MiB capture cap → **manifest-only** (version
  row, no bytes). Raise `ARTIFACT_CAPTURE_MAX_BYTES` ≥5 MB and it flows (under the
  16 MiB route limit) but buffers 5 MB in memory at 4+ hops + bloats `bytea`.
- **50 MB file** → even with the cap raised, **exceeds the 16 MiB route limit**
  (`MAX_ARTIFACT_UPLOAD_BYTES`) → `413`; and 50 MB whole-in-memory `bytea`
  insert+serve is unacceptable. **Hard-blocked by both the route limit and the
  storage model.**

**Real ceiling:** `bytea` field max is ~1 GB but the practical ceiling is far
lower — every hop loads the whole blob. **~16 MiB is the hard ceiling today**, and
even that is memory-heavy.

**Unblock options (all need Centaur work; the Atrium/CAS half is small):**
- **Cheap interim (~config only):** bump `ARTIFACT_CAPTURE_MAX_BYTES` →
  `MAX_ARTIFACT_UPLOAD_BYTES` (≈16–25 MB) + accept `bytea`. Covers most
  medium artifacts (PDFs, plots, small datasets) with **no architecture change**,
  but it's a band-aid (per-request memory + Centaur DB bloat until execution GC).
- **Real (100 MB+ datasets/video):** get bytes to object storage **without
  buffering**, which Centaur can't do today (no S3):
  - **(opt 1) sandbox → Atrium S3 via presigned PUT** — Atrium mints a presigned
    PUT (it has S3 + `cas/<sha>`), sandbox streams straight to S3, then emits a
    capture frame referencing the key. Cleanest + reuses the ledger; **pierces the
    egress=api-rs-only posture** (a controlled hole to S3/Atrium).
  - **(opt 2) stream through api-rs to Atrium S3** (no `bytea`, raise/remove the
    16 MiB limit, multipart via `@aws-sdk/lib-storage` on Atrium). Preserves the
    network posture; more api-rs+Atrium streaming code. The sandbox's existing
    chunked read makes its half cheaper than estimated.

**Verdict: NOT a daily-driver-v1 blocker** (the notebook = markdown + small
images, ≤1 MiB). Fast-follow. The **cheap cap-bump (~16 MiB)** is a one-config
lever that covers medium artifacts now; true large-file is a **dedicated Centaur
effort (opt 1/2), gated behind the ledger anyway** (the ledger's `cas/<sha>` +
multipart-serve is the small Atrium half).

## 6. Future layers — and how the substrate enables each (NOT in this build)

- **Promote / pin / `official`** — add pointer names; a pointer op over existing
  versions. No producer, no bytes. (Deferred: always-latest is fine for now.)
- **Channel-shared artifacts** ("consumers pin v2" across sessions) — a
  `(channel, name) → (artifact, seq)` reference layer over session chains.
- **Human write-back + conflict-state** — the direct-bytes `PUT` (server hashes,
  **`base` required = OCC** to prevent the silent lost-update the hand-compute
  found), `merge_class=mergeable-doc` runs **node-diff3** 3-way; clean → new
  normal version, conflict → `status=conflict` version carrying markers + the
  `conflict` jsonb, `latest` advances to it, resolution = a write-back against the
  conflict seq. (The schema's `base_seq`/`status`/`conflict` cols already exist
  for this — no reshape.)
- **Lineage + stale-downstream** — `artifact_lineage` edges (incl. a heuristic
  rename "renamed-from" when a `created`'s sha matches a just-`deleted` path's
  last blob); advisory invalidation, never auto-regenerate.
- **Multipart + GC** — `@aws-sdk/lib-storage` for >100 MB; mark-and-sweep
  unreferenced `cas_blobs` past a grace window (**clone the offload lease
  worker**) + working-history compaction (the 2.5 s feed churns; GC is "mandatory
  day-one" per the daily-driver trap — but the *unreferenced-blob* sweep can be
  the first GC; chain compaction follows).

## 7. Fan-out structure (build logistics)

Branch off clean `master` as `feat/cas-ledger`. Core ingest is sequential, so:
- **Foundation (lands first, gates the rest):** mig `033` + `ArtifactLedger`
  module skeleton + types. One worker or hand-built.
- **Then parallel lanes** (codex fan-out, worktrees, the `codex-delegation-pattern`
  recipe; self-review the cross-branch seams per `self-review-before-codex`):
  - Lane B — capture-bridge (`mirrorFrame` → versions + `latest`).
  - Lane C — offload→CAS re-key + `cas_blobs` population/dedup.
  - Lane D — serve-by-path route + reducer by-path "current version" view.
  - Lane E — tests (folded into B/C/D or its own pass).
  Seams: B and D both read the ledger; C changes storage under both → land B+C
  on the shared branch before D's serve assertions. Claude orchestrates: plan,
  review diffs firsthand, QA, merge.

## 8. Open decisions (asked before fan-out)

1. **Global dedup keying in v1** — re-key offload to `cas/<sha>` + `cas_blobs`
   (dedup day-one) vs. keep per-session keys, defer dedup.
2. **Working-history retention** — keep every distinct-content capture (GC later)
   vs. compact at ingest now.
3. **Build boundary** — Atrium-side ledger only (overlay + inbound sync stay
   future Centaur work) vs. also start the Atrium half of the invalidation
   channel now.
4. **Scope of this fan-out round** — capture-bridge substrate only, vs. also pull
   in human write-back + conflict-state (node-diff3) this round.

## 9. Hand-compute findings — concurrent shared editing (2026-06-19)

Hand-computed (skill: hand-compute) two agents + a human editing one shared doc
against the *built* `commitVersion`, to test "does it work while pulling in remote
changes mid-edit." It mostly doesn't yet — the built ledger is **session-scoped +
blind-append**. Five findings, each grounded in the shipped code:

1. **Blind-append capture silently loses updates on a shared chain.** Capture calls
   `commitVersion` with no `baseSeq` → `effectiveBase = latest.seq`, so it can never
   trip `stale_base` (`artifact-ledger.ts:277`); dedup only checks byte-equality
   (`:281–288`). Trace: A and B both hydrate v1, both edit, A captures (→v2), B
   captures (→v3, base_seq=2) — v3 = B's bytes, **A's v2 is buried**, no conflict.
   The optimistic-clobber shape, in the capture path. **Fix:** shared-artifact
   captures must be **base-aware** — pass the hydrated `base_seq`, hit the existing
   `stale_base` branch, run the node-diff3 3-way (the write-back lane's path). Keep
   blind-append only for **private** (single-writer, session) artifacts.

2. **Change-feed is session-scoped → can't see other agents.** `changedSince`
   filters `WHERE a.session_id = $1` (`:225`). An agent's feed shows only its own
   captures — useless for collab. Needs a **channel/subscription-scoped** feed keyed
   by the shared artifacts the session hydrated.

3. **C1 delivers bytes but never reconciles (for autonomous agents).** Stage-to-
   `~/.atrium/incoming/` + no-hot-swap correctly protects a dirty working copy (✓),
   but nothing makes a *running autonomous* agent act on the staged file — it's
   inert. Needs a **reconcile trigger** (daemon writes incoming + a conflict marker
   the harness surfaces as a steer). Human-in-app is fine (sees a banner).

4. **Watermark cursor drops same-timestamp versions.** `changedSince` uses
   `created_at > $2` (`:225`); two versions sharing a `created_at` → the second is
   skipped forever if the daemon watermarks on that timestamp. **Fix:** cursor on
   `(created_at, seq)`; advance the watermark to the max row *returned*, not
   wall-clock. (`pg_notify` firing inside the commit tx at `:202` is correct — keep.)

5. **"Reconcile at the ledger" is within-artifact (built), shared is cross-chain.**
   The built conflict-state is `stale_base` on the *same* artifact. Per-session
   chains + a channel pointer would need a **new cross-artifact merge engine** at
   promote. **Resolution:** model a shared doc as a **single chain** identified by
   `(channel, name)`, so the shared-edit merge IS the within-artifact path already
   built. Identity bifurcates: **private = `(session,path)` blind-append**;
   **shared = `(channel,name)` base-aware + conflict-state**.

**Scope correction.** "Channel-shared = a modest pointer table" is wrong for
concurrent editing — a pointer is modest, multi-writer merge is not. The
small-but-correct delta: add the `(channel,name)` shared identity + make capture
base-aware for shared artifacts (reuses built OCC/node-diff3). **Single-player v1
(human in app + one agent in sandbox) is already served** — a within-artifact
human↔agent conflict, the built path — *provided the agent's capture is base-aware*
(else the agent blind-append clobbers the human's write-back). The multi-*agent*
live case is the deferred C1 work, now with findings 2–4 folded into its spec.

**New open decision (5):** take base-aware-shared-capture + `(channel,name)`
identity in v1 (needed the moment an agent and you co-edit a doc), or stay
session-private for v1 and gate all shared editing behind C1? **Recommend the
former** — it's small, and it's what lets the chief-of-staff agent edit your notes
without silently clobbering your edits.

> **RESOLVED in §10.1** — and went *broader* than `(channel,name)`: identity is
> workspace-scoped (`(workspace, canonical_path)`) with scope folded into reserved
> prefixes (`shared/...` and `scratch/...`).

## 10. Revised decisions — design pass after the build (2026-06-19)

A design conversation after v1 landed (Gary) settled the open items from §8/§9 and
reversed two earlier calls. **These supersede the narrower models above.**

### 10.1 Identity = workspace-scoped, path-prefix scoping (supersedes `(session,path)` / `(channel,name)`)

> **UPDATE 2026-06-25 (scope/mount clarification): the current canonical model is
> active-shared-root + session scratch, both backed by `(workspace, canonical_path)`.** A naive
> `report.md` in `~` maps to the session's **active shared leaf**
> (`shared/channels/<active>/report.md`, or another Atrium-selected shared prefix). Private
> durable files are explicit: `~/scratch/foo` maps to `scratch/<session-id>/foo`. Both use the
> same artifact/CAS/version/GUI machinery; ACL comes from reserved path prefixes, not a new
> `space_id` table in v1. Canonical: `notes/shared-workspace-build-spec.md` §0.1–§0.3.
> (Original §10.1 text below kept for lineage.)

Default is **shared across the whole Atrium workspace** — sessions share artifacts
*across channels*, not just within one. The identity key is effectively
**`(workspace, fullpath)`**; session/channel tags are **not** the key (kept only as
denormalized provenance/access metadata, if at all). "Scope" folds into the **path
prefix**, interpreted by the filter/access layer — no separate scope column, no
per-artifact tag machinery:

- `scratch/<session>/…` → **session-scoped artifacts**. Same version/writeback machinery; narrower
  ACL; not hydrated into sibling sessions by default.
- `shared/global/…` → **workspace-wide artifacts**.
- `shared/channels/<active-channel>/…` → **active channel-scoped artifacts** for the session.
- `shared/projects/<project>/…` → **future project-scoped artifacts**, only once "project" is a
  real product object with an ACL resolver. Current code rejects this prefix and non-active
  channel ids rather than accepting arbitrary ids.

To keep collisions *structural, not accidental*, Atrium selects one active shared
leaf and materializes it at `~`; writes in cwd are therefore scoped without the
agent learning the canonical prefix. **Access-control follows longest matching
reserved prefix**; agents can create subdirs inside granted leaves, but cannot create
new scopes by `mkdir shared/channels/foo`. **Net vs §9:** the bifurcation
"private=`(session,path)` / shared=`(channel,name)`" becomes "all artifacts are
`(workspace, canonical_path)`, with reserved prefixes deriving ACL." Shared and
scratch captures both use the artifact version chain; scratch is private by ACL, not
by a separate storage system.

### 10.2 Notes → artifact-canonical (REVERSES daily-driver §2)

The braindump/chief-of-staff notebook moves from **chat/Postgres-canonical +
read-only mount** to **artifact-canonical files** in the CAS-ledger; chat becomes an
**input method + rendered view** over the doc, not the source of truth. Agents edit
notes like any other artifact (base-aware, conflict-state).

**The one user story this risks** = the frictionless **append-only voice/mobile
braindump** ("talk while walking, never think about where it goes") — a *document*
forces "where does this thought go?" that the chat *stream* doesn't. Protect it with
**two write modes over the same file substrate**:
- **append** (voice/quick-thoughts → an append-only daily/log artifact) — *never
  conflicts* (appends commute; no diff3), and
- **edit** (structured docs) — base-aware, conflict-state.

This also dodges the wrong-feeling case of a *braindump* throwing conflict-state
because you voice-appended while an agent edited it. Everything else (search,
agent-memory) is fine or **better** — notes are now directly greppable files, no
projection step.

### 10.3 Freshness — live mid-session inbound (C1) is IN SCOPE (not deferred)

A *running* agent must see another actor's edit **within seconds**, not at next
hydrate. C1 is the full chain: ledger `latest` advances → Atrium NOTIFY → api-rs →
**stdin poke** → harness pulls + stages. The **egress-poll inbound daemon stays the
floor** (harness-agnostic, no-ingress-clean); the **stdin poke is the latency cut**
layered on. Real dependency risk (open verification item): does codex/claude/amp act
on a new stdin `source` line or treat all stdin as a user turn? If a harness can't,
it falls back to poll. (See `inbound-sync-spec.md`.)

### 10.4 Autonomous reconcile = auto-rebase, with a safe-point rule

An autonomous agent (no human watching) that hits an inbound change colliding with
its in-flight edit **auto-rebases (node-diff3) and continues** — flagging the
conflict inline (markers) + recording a `status=conflict` version — *not*
pause-and-wait. Hard rule: **never splice bytes into a file the agent is mid-write
on.** The daemon stages to `incoming/`; the **harness adopts the merge at a
checkpoint** (next read / between edits). Auto-rebase = the agent *deliberately*
picking up the merge, not the daemon hot-swapping under it. (This is jj's
materialize-resolve-rebase-forward loop, agent-driven.)

### 10.5 Conflict model = jj-style state (already built), CRDT opt-in only

We are **already jj-style**, not git-style: conflicts are first-class committable
state (`status=conflict` version, `latest` advances to it, never blocks,
resolve-later) — jj's *model*, not git's *blocking* merge. **node-diff3 is just the
merge algorithm** (git and jj both use 3-way textual merge; the difference is what
happens on a non-clean merge — we store-as-state). We do **not** adopt true
conflict-free (**CRDT**) as the tracking model: agents emit file overwrites, not
CRDT ops; CRDT convergence ≠ correctness (silently merges two `function foo()` into
broken code); it covers only one merge-class; and it wants a live connection (anti
no-ingress). **CRDT stays a narrow opt-in fast-path in the human in-app editor** for
live co-typing, committing back to the chain as ordinary versions — never the agent
write path.

### 10.6 diff3 gated by merge_class / type policy

diff3 is line-based textual merge; route by merge-class (the schema lever already
exists):
- **Binaries** (png/pdf/img/audio/compiled) → `immutable-data`, **never diff3**
  (line-merge on bytes = garbage); conflict = keep-both, last-writer `latest`.
- **Structured-serialized** (JSON/YAML/TOML/CSV/`.ipynb`) → **diff3-unsafe**: a
  textual merge can produce *syntactically invalid* output ("merged but won't
  parse"). Treat as **whole-file conflict-state (both sides), not line-merge**;
  notebooks especially (nbdime-style later).
- **Line-oriented text** (code, markdown prose) → diff3 **OK**. Caveats: prose
  reflow/rewrap reads as many line-changes → false conflicts (diff3 conservatism,
  already noted); normalize CRLF (node-diff3 is trailing-newline-safe, not
  CRLF-safe). Word/semantic diff is a later upgrade; conflict-state is lossless
  meanwhile.

### 10.7 Code repos excluded from the shared-artifact pool

A repo checked out in two containers must **not** be artifact-synced between them —
that fights git (merging branch A's working tree into branch B's is incoherent; git
branches exist for exactly this). Principle: **code = coordinate around git
(git-on-forge canonical); Atrium does not reinvent VCS.** Today only `.git/` is
capture-ignored — that stops metadata but **not** tracked source files. Extend the
filter: **anything under a git working tree (a `.git` at/above it) is excluded from
artifact-*sharing*** — git owns it; shareable deliverables are written *outside* repo
roots, into the shared namespace (§10.1). (Capture-for-history, derived from `git
diff`, is separate from share-across-containers; you may want the former, never the
latter.)

### 10.7b Capture mechanism — DECIDED: overlay-upper node-scan (see Track C4)

The capture watcher is a **2.5s polling stat-walk** today (`artifact_capture.py`) —
O(workspace dirs) per scan, per pod, no delete/rename, ≤2.5s latency. **Decision
(2026-06-20, Gary: "scalable/permanent, not an MVP"): the target capture
architecture is the overlay-upper node-scan in Track C4** — O(changes) scan, O(nodes)
scanner, delete/rename fidelity, zero agent footprint, native large-file path.
**POC-confirmed 2026-06-20, end-to-end** — kernel (9/9 on the real agent image, kernel
6.12) **and** k8s wiring (kind: privileged-init `Bidirectional` + agent
`HostToContainer`). No residual feasibility unknown — see Track C4.

The earlier event-driven candidates are **demoted to fallbacks** (relevant only where
node control is unavailable — *not* our self-managed environment):
- **`inotify` hybrid** (in-agent, unprivileged) — bounded by `fs.inotify.max_user_watches`
  (8192, per-UID-per-node, shared across same-UID pods) → **doesn't scale** to large
  or many workspaces; only a fallback.
- **`fanotify` filesystem-mark** — O(1) in dirs but `CAP_SYS_ADMIN` + watches a whole
  superblock (node-fs torrent unless on a dedicated per-pod fs); the node-scan of the
  upper achieves the same scale without the event-stream drop risk.
- The current **2.5s poll** stays as the managed-restricted fallback.

Tie-in: the inbound daemon (§10.3 / `inbound-sync-spec.md`) has the *same*
poll-vs-event question on the network side; C4's node component is the natural place
the inbound-pull also lives.

### 10.8 Through-line: the path/filter layer carries the policy

Scope (session scratch / channel / project / global), code-vs-artifact, and
diff3-eligibility are all **policy keyed off canonical path + type + merge-class** — not
new machinery. The reserved-prefix convention + the existing filter + `merge_class` do
the work. That the model collapses onto one layer is a sign it's holding.
