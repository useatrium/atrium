# Agent workspace sync — inbound + outbound (overlay-era redesign)

> **Status: PROPOSAL (2026-06-20).** Supersedes the in-container sync model in
> `inbound-sync-spec.md` (Track C1) and unifies it with the outbound capture in
> `cas-ledger-build-plan.md` Track C4. Written after the C4 decision (capture moves to
> a node-level overlay-upper scan), the 9/9 kernel POC, and a hand-compute of the
> staleness + delete-vs-edit flows. The CAS-ledger itself does **not** change; this is
> the producer/sync layer around it.

## 0. Why a redesign (the one-paragraph why)

The old sync model (C1) put **both** directions *inside* the sandbox — an in-container
egress-poll daemon out, a stdin-poke + harness handler in — forced by no-ingress and
the fact that, pre-overlay, only an in-container process could see the FS. The **C4
decision moved capture to a node component** (scan the overlay `upper` from outside the
hardened agent). Once capture is node-side, the inbound half should move too, and the
whole **no-ingress/stdin-poke complexity largely evaporates** — because the node
component *is not the sandbox*: it has full connectivity, polls the ledger directly,
and stages bytes to a volume. What must stay in-container is only the *merge into the
live working copy*, because overlay forbids external modification of its layers and the
no-hot-swap rule needs agent coordination. This doc is that redesign.

## 1. The core reframe — overlay is copy-on-write, not sync

OverlayFS never merges `upper` into `lower` and never refreshes `lower`. For the life of
the mount there are **three versions** of any shared artifact, and reconciliation is a
**ledger-mediated process bolted on beside the overlay — not an overlay operation**:

```
lower[path]    = the version THIS container hydrated at startup     (FROZEN, read-only)
upper[path]    = the agent's edit, if any                            (this container's working copy)
ledger.latest  = the global truth other actors keep advancing        (durable; moves under you)
```

Consequence that drives everything below: **a file the agent didn't edit is pinned to
its startup snapshot** (it resolves to `lower`), so freshness is *not* automatic — it
requires the inbound path to actively pull + adopt. Overlay solves *local execution*
(full POSIX, no EROFS, free changed-set in `upper`); it does **nothing** for freshness
or merge.

## 2. Workspace composition — structural scoping (answers "filtering & upper bloat")

**The overlay covers ONLY the artifact namespace.** Everything we'd otherwise filter is
a *separate volume*, so it never enters the overlay `upper` (no capture, no bloat — by
construction):

```
/workspace/
  proj-x/  shared/   ← OVERLAY  (lower = hydrated artifacts RO; upper = agent edits)   → node-scan CAPTURES
  <repo>/            ← separate volume (git CoW clone; git owns it)                     → never captured / never bloats upper
  node_modules/ .venv/ .cache/  ← cache volume(s)                                       → never captured / never bloats upper
  scratch/           ← ephemeral emptyDir (private)                                     → not captured
```

- **Capture filtering** (junk/secrets/path-globs) stays, but only as *defense-in-depth
  within the artifact namespace*. The big exclusions (repos, deps, caches) are
  **structural**, not filter-based — strictly more robust (can't capture/bloat from a
  dir that isn't in the overlay).
- **`upper` disk bloat** is otherwise the real new failure: copy-up of deps/git/build
  output fills the upper volume → agent writes fail **ENOSPC mid-operation**. Structural
  scoping prevents most of it; still **size + monitor the upper volume**. The upper is
  the live working set (not GC-able mid-session); it's reclaimed at session end / pause.
- **Repo docs (`.md` etc.) — DECIDED 2026-06-20: location-as-backing, NOT dual-store.**
  A file in a repo is **git-backed only**; a file in the artifact namespace is
  **ledger-backed only** — *one source of truth per file, chosen by where it lives.* We
  do **not dual-store** (capture a repo file into the ledger too): the ledger is
  branch-blind while a repo file is branch-specific, so `(workspace, path)` would collide
  across branches, and an edit would advance two stores with no canonical winner — the
  exact incoherence repo-exclusion exists to prevent. **The UX is preserved by unifying
  the *surface*, not the storage:** the Files/gallery/preview/editor is **polymorphic over
  backing** — it shows + previews + edits files from *both* git and the ledger in one
  view, pulling history from git (repo files) or the ledger (artifacts) as appropriate;
  editing a repo file in-app = a **git commit** (branch-aware), editing an artifact = a
  ledger write-back. So a repo `.md` is **not "dropped" — it's git-backed and shown via
  the unified surface.** The user/agent chooses backing by intent: version-with-the-code
  → put it in the repo; standalone conflict-state co-edit → put it in the artifact
  namespace. (Cost: the unified surface is new work — today's gallery reads
  `artifact.captured` frames only; adding a git-backed source + a git-commit write-back
  path. Aligns with daily-driver §3 "one Files abstraction.")

## 3. Outbound (capture) — node-scan of the upper

Per C4: a privileged **node DaemonSet** (one per node, O(nodes)) scans each container's
overlay `upper` (= the changed set, O(changes)), interprets overlay encoding
(regular→created/modified, char-dev 0/0→delete, `trusted.overlay.redirect`→rename), reads
bytes, and POSTs **direct to Atrium S3** (bypasses the `bytea` ceiling → large-file path).

**Cadence — this replaces the old 2.5s in-container whole-tree poll.** The watcher is now
*outside* the container, and it does **not** walk the whole workspace: it scans the
`upper` (only the changed set, so an interval scan is cheap, complete — a state-diff, no
event-drop — and doubles as the reconcile sweep). **Because the node is privileged it can
also run `fanotify`/`inotify` on the `upper`** (the hardened agent never could) → optional
event-driven, sub-second capture with the interval scan as the completeness backstop. So:
node-side changed-set scan (floor) ± node-side `fanotify` (latency) — *not* a 2.5s
whole-tree timer.

Two requirements this doc adds:
- **Base-aware capture** (the §9 fix): the scan must pass the *hydrated base seq* per
  path so concurrent shared edits route through OCC/diff3 instead of blind-append. →
  needs the **hydration manifest** (§5).
- **Torn-read gate:** detect-changed-during-read + re-read (rsync/restic pattern) and/or
  inspect `/proc/<agent-pid>/fd` to skip files currently open for write.

## 4. Inbound — node fetch + stage, in-container checkpoint adopt

The split, and **why each piece lands where it does**:

| Step | Where | Why there |
|---|---|---|
| **Fetch + stage** — poll ledger for advances on this container's hydrated paths; fetch bytes; write to a per-container **`/incoming` staging volume** (separate from the overlay) + a marker `{path, base_seq, new_seq, sha}` | **node** | node has full connectivity (not no-ingress); `/incoming` is not an overlay layer, so writing it is always safe |
| **Notify** — tell the agent "paths changed" | node→agent | a marker file in `/incoming` the harness polls (cheap, local), or an optional stdin poke. The bytes never ride stdin. |
| **Adopt** — merge the staged version into the live working copy | **in-container, checkpoint-gated** | overlay forbids external modification of `lower`/`upper`; the only legal write is *through `merged`* (a copy-up); doing it under a running agent is a hot-swap → must be agent-coordinated |

**Adopt has three cases** (from the hand-computes, §6):
1. **unedited** (`upper[p]=∅`) → write new bytes through `merged` → copy-up. *Still a
   coordinated hot-swap* (the file changes under the agent) → at a checkpoint, not mid-read.
2. **edited** (`upper[p]=ours`, base known) → `diff3(base, ours, theirs)`: clean → write
   result + capture (base=new_seq); conflict → write markers + ledger `status=conflict`.
3. **resurrect** (agent deleted it → whiteout; remote edited) → remove the whiteout by
   writing the resurrected bytes through `merged`.

**Autonomous vs human:** autonomous agents need a reconcile trigger (the marker surfaced
as a steer; auto-rebase via case 2 at a safe checkpoint). Humans-in-app get a banner.

## 5. The load-bearing new pieces (what C1 lacked)

1. **Hydration manifest** (`path → base_seq`, written at startup) — needed by *both*
   base-aware capture (§3) and adopt-time diff3 (§4). The single most important missing
   piece; without it capture blind-appends and adopt can't 3-way merge.
2. **Per-container hydration subscription set** — the node polls the ledger only for the
   shared paths this container actually hydrated (the §9 "workspace/topic-scoped feed"),
   not all artifacts.
3. **`/incoming` staging volume** — a per-container volume the node writes and the agent
   reads, *outside* the overlay (so neither side pokes the overlay layers).
4. **Checkpoint adopter** — the in-container handler doing cases 1–3 through `merged`.

## 5A. Durability coverage — one mechanism, three destinations (by content class)

Capture is **not artifact-only**: it's one node-side mechanism that routes by content
class to the *right durability shape*. Forcing everything into the version-ledger is the
mistake (logs churn it; code fights its branch model).

| Content class | Destination | Why there |
|---|---|---|
| **Artifacts** (`proj-x/`, `shared/`) | version-**ledger** (CAS + chain + pointers + conflict-state) | edited, versioned, workspace-shared |
| **Code working-state** (repos) | **git shadow-ref** (`refs/centaur/wip/*`, pushed to forge/mirror) | git owns it; branch-aware; the only durable home for *uncommitted* repo work |
| **Logs / transcripts** (`~/.codex`, `~/.claude`, …) | **chunked CAS blob + append-index** (NOT a version chain) | append-only; resume consumer; versioning is the wrong shape |

**The uncommitted-repo-work hole + fix.** Repo files are excluded from the ledger
(branch-incoherent — see §2). Git only makes work durable *at commit*, so uncommitted
edits are lost on crash/destroy (survive pause only on a persistent repo volume). Fix =
a **side-effect-free shadow snapshot** on a heartbeat, run by the node daemon against the
repo volume — **never** a real auto-commit (that mutates HEAD/branch/index the agent
reasons about and races `.git/index.lock`):
```
GIT_INDEX_FILE=<persistent wip-idx> git add -A   # separate index → no contention; respects .gitignore (auto-excludes deps/junk)
tree=$(… write-tree); commit=$(git commit-tree $tree -p HEAD -m wip)
git update-ref refs/centaur/wip/<ts> $commit; git push <mirror> refs/centaur/wip/<ts>
```
Invisible to `git status`/`git log`/`git branch` (non-default ref namespace). **Overhead
to manage:** the wip-index must be *persistent* (else `add` is O(repo) each time); prune
old wip-refs + gc (they pin objects); decouple push cadence from snapshot cadence; torn
snapshots are fine (best-effort recovery points). It runs over **disjoint paths** from
the artifact scan (repos vs the overlay upper) → no double-capture, no logical
contention; they share the node daemon's resources, egress, and pod→session attribution.

**Transcripts** (the rollout JSONL) are *mechanically* capturable by the same node
file-watch — they're just not in `/workspace` and they're a *log*, so they route to the
log destination (chunked blob + append-index), feeding harness-resume, not the gallery.

## 5B. Storage layout & hydration — `lower` is a checkout, not a byte-merge

**The store is heterogeneous by class:**
```
ARTIFACTS   → S3 cas/<sha> blobs + PG ledger;  whole file = 1 blob;  chunked = manifest{chunk-shas} + N chunk blobs
CODE        → git objects on the FORGE/mirror (NOT our S3), incl. refs/centaur/wip/*
LOGS/XCRIPT → S3 cas/<sha> chunk blobs + an append-index
```
There is **no single merged blob**. Artifacts + log-chunks share the `cas/<sha>` store;
**code lives entirely in git's store** (we don't put repo objects in our S3).

**Hydrating the artifact `lower`** (the RO lowerdir of the artifact overlay — repos/deps
are *separate volumes*, not this) is a **checkout**, mostly *not* a merge:
1. Resolve the session's scope → the **hydration manifest** (`path → version/base_seq`) —
   the same object §5 needs for base-aware capture; it *is* the lower's content list.
2. Per path: ledger → latest version → a **blob_sha** (whole file) or a **chunk-manifest**.
3. Fetch S3: whole file = **1 GET**; chunked = GET chunks + **concat** (the *only* real
   byte-merge, and only for chunked large files — normal artifacts never concat).
4. Materialize the files into the lowerdir tree → overlay mounts it RO.

So "blobs merged together" = **a tree laid out one-blob-per-file by path**, not blobs
concatenated. Conceptually: artifact `lower` = a **CAS checkout** (tree-manifest →
per-file blobs); the repo = a **git checkout** (separate volume). Two checkouts, two
stores, composed into `/workspace`.

**Scale levers (design, not built):** a **node-local CAS cache** (`/var/lib/centaur/cas/<sha>`)
materialized into `lower` by **reflink/hardlink** (content-addressed → free dedup across
pods; mirrors the existing repo-cache hostPath); and a **tree-manifest** object
(`path→sha` for the whole scope, à la a git tree / lakeFS range) so hydration is one GET
for the tree + cache-miss blob GETs, not N ledger lookups. *None of lower-hydration is
built today* (workspace is `git clone --shared`, no artifact-lower); the ledger +
`cas/<sha>` + serve-by-path exist, but `hydration-manifest → materialize-lower` is new.

## 5C. Small objects & packing — don't make one S3 object per append

The chunked-log + fine-grained-working-history model would **explode tiny S3 objects** if
naive (one object per appended line → per-PUT cost, per-prefix rate limits (~3,500 PUT/s),
slow LIST/GC, N-round-trip reads). The fixes, in layers:
- **Chunk at MB scale** (CDC ~1–4 MB), never per-line; appends **buffer until a chunk
  closes**.
- **Heartbeat-batch** — capture on an interval, so a flush is *one delta*, not one
  per write.
- **Pack** — content-addressed chunks go into **pack files** (≤64–128 MB, git/restic
  style) with a `sha→(pack,offset,len)` index in PG; reads = **range-GET**. Millions of
  tiny chunks → thousands of pack objects + an index. (The "pack chunks into ≤64 MB
  blocks" the data-arch already noted — applies to logs + working-history, not just media.)
- **PG hot-tier** — the growing tail / recent working-history stays in PG `bytea` and only
  **seals to S3 (packed) when cold/large** — the existing offload-worker pattern.
- Cross-cutting: **content-dedup** (identical bytes → no new blob), **GC** (mark-sweep
  unreferenced — mandatory day one), **compaction** (thin working-history).

**This is the trigger to un-defer CDC** — parked as a media optimization, but append-heavy
transcripts/working-history are where it earns its keep. v1 (single-user, modest logs)
tolerates per-interval delta + dedup + GC; **packing + CDC are the scaling answer.**

## 5D. Build vs buy — commodity OSS vs the must-build glue

Most *individual layers* here are well-trodden infra with mature OSS — we should **reuse
the commodity, build only the glue.** The mistake would be hand-rolling chunking/packing
or log storage.

| Layer | Strong OSS prior art | Stance |
|---|---|---|
| Chunking / CDC / pack / dedup | **restic, borg, Kopia, casync/desync, Xet, git packfiles** | **REUSE** — hand-rolling CDC + pack-GC + repair is a multi-year trap. Pull a chunker lib / sidecar when we un-defer CDC. |
| Content-addressed blob + versioned refs over S3 | **lakeFS, Nessie, Dolt, git** | **BUILD (already decided)** — the spike chose own-CAS-ledger 39–29 over lakeFS, but only because lakeFS lacks **jj-style conflict-state** + per-tenant RBAC. That justification holds for the *conflict/version metadata*, not the blob plumbing. |
| WIP working-copy snapshots | **`dura` (auto-commit to a shadow ref), jj (auto-commits the working copy)** | **REUSE the pattern** — the §5A shadow-ref snippet *is* what `dura`/jj do; it's ~a script, not a system. |
| Append-only log storage | **Loki, Vector, Kafka log-segments** | **REUSE the pattern** (segment + index); don't invent log storage. |
| POSIX over object store (lazy hydrate) | **JuiceFS, SeaweedFS, Mountpoint-S3** | **EVALUATE** — JuiceFS handles the rename/lock/fsync cases naive FUSE fails; could be the hydrate/serve layer (it doesn't do versioning/conflict/no-ingress). |
| File sync between hosts | **Syncthing, Mutagen, rclone** | **N/A** — they need reachability; **no-ingress disqualifies them** (this is *why* we build the egress sync). |

**What is genuinely must-build (the glue, no single product fits):** the **no-ingress
egress-only sync orchestration**, the **overlay-upper node-scan capture**, the
**agent-UX policy** (structural scoping, merge-class, filtering, workspace-scoped
identity), the **jj-style conflict-state ledger** (lakeFS can't), and the **per-tenant /
VM model**. `agent-data-architecture.md` already concluded *no single off-the-shelf
system* does this exact combination (no-ingress + large-binary + versioned-with-merge +
multi-shape + agent-semantics) — "the integration is the product."

**Honest meta-observation:** we keep re-deriving **jj's model** (conflict-as-state,
auto-committed working copy, change-ids, op-log). That's a signal, not a coincidence —
jj is the conceptual reference. We don't *run* jj because its scalable S3 cloud backend +
CDC layer are Google's **closed** pieces (per the prior eval); so this is "jj's model on
our own backend, for the no-ingress agent context." Legitimate, but worth naming so we
borrow jj's *design* deliberately instead of accidentally.

**Recommendation:** before building the chunking/packing/log layers, run a focused
**build-vs-buy eval** (analogous to the lakeFS spike) over restic/casync/Xet (chunk+pack
as a library or sidecar), `dura`/jj (WIP), and JuiceFS (hydrate/serve). v1 stays
whole-object (the spike's deferral); reach for the chunker when un-deferring CDC — don't
write our own.

## 6. Hand-compute evidence (the flows that justify §4)

**#1 staleness (unedited file):** A hydrates `plan.md`=v5 into `lowerA`; B advances it to
v6 in the ledger; A's `lower` stays v5; `agentA` reading `/workspace/proj-x/plan.md`
resolves `upper=∅ → lower → v5` and acts on **stale** content with **no signal**. Fix =
node stages v6 to `/incoming` + marker; adopter (case 1, unedited) writes v6 through
`merged` at a checkpoint. ⇒ staleness is the *default*; freshness requires active
pull+adopt; even unedited adoption is a coordinated hot-swap; base_seq must be known.

**#5 delete-vs-edit:** `agentA` deletes `old.md` → whiteout in `upperA` → node-scan
captures a DELETE (ledger v4, base v3). `containerB` (lower still v3, never saw it) edits
`old.md` → capture with base v3 ≠ latest v4 → `stale_base` → **delete-vs-modify
conflict** recorded. ⇒ the built conflict-state catches it *iff capture is base-aware*;
resolution is a product decision (stay deleted vs resurrect); resurrect = adopter case 3
(remove whiteout); and B did doomed work with no signal (same staleness gap).

## 7. What's built / new / redesigned

| Piece | Status |
|---|---|
| CAS-ledger (S3 CAS + PG version chain, conflict-state, write-back PUT) | **built** (PR #35) — unchanged |
| Capture-out, in-container 2.5s poll (`artifact_capture.py`) | **built** — **retired** by C4 (kept as fallback for managed-restricted nodes) |
| Capture-out, node-scan of upper (C4) | **new** (kernel mechanism POC-confirmed 9/9) |
| Hydrate-into-lower at startup (ledger → overlay lower) | **new** |
| Inbound fetch+stage (node) + checkpoint adopt (in-container) | **new** — redesigns C1 (was in-container daemons + stdin-poke-primary) |
| Hydration manifest + subscription set + `/incoming` | **new** |

## 8. Open items / risks (not closed by this design)

- **Lower stability across pause/resume** — resume re-mounts the persisted `upper` over a
  re-provisioned `lower`; `lower` must be byte-identical (same base versions) or the
  upper's deltas drift. (Track C4 commitment #3.)
- **Delete-vs-edit resolution UX** — stay-deleted vs resurrect is a product call.
- **inotify *inside* the container** — the agent's own file-watchers (dev server hot-reload)
  on an overlay `merged` have historical gaps for lower-originated events; distinct from
  node-side capture.
- **Overlay POSIX quirks** — hardlink-break on copy-up; `redirect_dir=on` required for
  lower-backed dir renames; inode-number changes on copy-up.
- **k8s mount-propagation wiring — CONFIRMED end-to-end (kind, 2026-06-20).** Privileged
  init mounts the overlay `Bidirectional` onto a hostPath; the hardened agent
  (UID-1001, `drop:[ALL]`, `seccomp:RuntimeDefault`) mounts it **`HostToContainer`** and
  writes through `merged`; node verified `upper` bytes, copy-up, whiteout, `shared`
  mount. **Correction:** k8s forbids `Bidirectional` on a non-privileged container →
  **setup = `Bidirectional`, agent = `HostToContainer`** (the §2/§4 provisioning must
  reflect this). Remaining ops detail: the init-mounted overlay persists on the node
  after the init exits → **unmount-on-pod-teardown** (else orphaned node mounts).
- **Multi-tenant blast radius** — the node sync daemon reads all pods' uppers on its node
  → VM-per-tenant (hypervisor boundary; per-tenant node → per-tenant daemon).
- **WIP shadow-snapshot overhead** (§5A) — persistent wip-index (else `add` is O(repo));
  prune wip-refs + gc; decouple push cadence; gc/repack races with the agent.
- **Build-vs-buy eval before the chunking/packing/log layers** (§5D) — evaluate
  restic/casync/Xet (chunk+pack), `dura`/jj (WIP), JuiceFS (hydrate/serve) rather than
  hand-roll. v1 stays whole-object; reach for a chunker when un-deferring CDC.
- **Repo-`.md` UX — DECIDED 2026-06-20 (§2):** location-as-backing (git for repo files,
  ledger for artifact-namespace files), **no dual-store**; UX preserved by a polymorphic
  **Files surface** over both. The only *remaining* work is building that unified surface
  (git-backed source + git-commit write-back) — an Atrium UI task, not a design open.

## 9. Relationship to other docs

- `cas-ledger-build-plan.md` Track C4 — the outbound/capture half + the overlay
  provisioning; this doc is its inbound complement + the unified picture.
- `inbound-sync-spec.md` — **superseded** by §4 here (in-container daemon → node-side
  fetch/stage; stdin-poke demoted to optional notify).
- `agent-data-architecture.md` — the overlay execution model + merge-class/conflict-state
  this builds on.
