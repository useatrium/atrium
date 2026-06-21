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

## 2A. The agent's view — `/workspace` (work) + `/atrium` (read-only context)

The agent's whole filesystem, laid out for **agent UX** (it greps/cats a predictable tree;
the no-ingress constraint stays out of its way). DECIDED 2026-06-20.

```
/workspace/                      ← WRITABLE work area (the overlay; the ONLY captured tree)
  proj-x/  shared/  scratch/<session>/  <repo>/  node_modules/ .venv/ .cache/
/atrium/                         ← READ-ONLY context (separate mount; NEVER captured;
  README                            ONE shared copy per node, reflinked into each pod)
  chat/<channel>/<thread>.md     ← Atrium chat, projected from the events log — live append-tail
  sessions/<id>/transcript.jsonl ← sibling sessions' raw traces — live append-tail
  sessions/<id>/{summary.md,meta.json}
  artifacts/<path>               ← read-only latest-by-path view over the ledger
+ query tool: `atrium search|read|log`  (targeted, always-fresh, reaches the wide cold tail)
```

**Decisions (Gary, 2026-06-20):**
- **Two roots, two jobs.** `/workspace` = the agent's work (writable, captured). `/atrium` =
  the world (read-only). The agent never conflates deliverables with ambient context, and
  capture has exactly one tree to watch.
- **Both layered** (chosen): the mounted tree is the ergonomic grep/cat default; the `atrium`
  tool is the power tool for fresh/targeted/beyond-scope lookups.
- **Visibility = workspace-wide by default, scope-knob later** (chosen). Affordable ONLY
  because `/atrium` is **one shared per-node projection** reflinked into pods (content-
  addressed → free dedup). Naive per-agent eager push is **O(sessions²)** write-amp (~80k
  appends/s at 200 agents — hand-compute); shared-per-node collapses it ~200×. Eager-tail the
  near scope (own + channel/topic); serve the wide cold tail lazily via the tool. The scope
  knob tunes eager-vs-lazy + recency/active-only to cut noise.
- **Freshness = live append-tail** (chosen). chat/transcripts are append-only → the node just
  appends new events to the file tail (no merge, no quiesce). Artifacts in `/workspace` use
  the §4 node-side merge. **Steers/HITL ride the normal message stream, NOT a marker file.**

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

## 4. Inbound — node fetch + **node-side merge** (write-through-`merged`), harness quiesce

**DECISION 2026-06-20 (revises the earlier in-container adopter; Gary's catch — "why rely on
in-container pull instead of the outside daemon, and the `/incoming` channel is weird for
agent UX").** Inbound moves to the node, **symmetric with capture (§3)**. The node does
fetch + merge + the write; the only in-container residue is a lightweight quiesce signal.

| Step | Where | Why there |
|---|---|---|
| **Fetch + merge** — poll ledger for advances on hydrated paths; fetch `theirs`; `diff3(base, ours, theirs)` (`ours` = the agent's `upper`, which the node already reads for capture) | **node** | node has full connectivity **and all three merge inputs** (base from manifest, ours from upper, theirs from ledger) |
| **Write** — write the reconciled bytes into the live working copy **through the shared `merged` mount** (the normal, allowed overlay write path; reachable from the host via `rshared`) | **node** | writing *through* `merged` is legal (unlike poking `upper`/`lower` directly while mounted); the host reaches `merged` per the kind POC |
| **Quiesce gate** — only write when the agent isn't mid-read of that path | **harness "between-steps" signal + node `/proc/<pid>/fd` check** | the *sole* residual in-container concern is **timing** (don't clobber an open file), NOT access; the signal is harness-level, **invisible to the model** |

**Why this revises the prior "in-container adopter":** the earlier rationale ("overlay
forbids external modification → adopt must be in-container") was **over-stated**. You can't
poke `upper`/`lower` directly while mounted — but writing **through `merged`** is the normal
write path, and the kind POC showed `merged` is **writable across mount namespaces via
`rshared`** (a separate-ns writer landed bytes in `upper`). So the node can do the write.
What genuinely needs the container is only **hot-swap timing**. ⇒ **`/incoming` + the
in-container 3-case adopter are demoted to internal node mechanics, never agent-facing.**

**The three merge cases still exist — but the NODE runs them:**
1. **unedited** (`upper[p]=∅`) → node writes new bytes through `merged` at a quiesce point.
2. **edited** (`upper[p]=ours`, base known) → node `diff3`: clean → write; conflict → write
   markers + ledger `status=conflict`.
3. **resurrect** (agent deleted → whiteout; remote edited) → node writes resurrected bytes.

**Append-only context (chat / sibling transcripts, §2A) is simpler still:** no merge, no
quiesce — the node just **appends new events to the file tail**.

**Steers / HITL = the normal message stream, NOT a `/incoming` marker.** A chat-native agent
already drains its conversation input; a steer is a message in the thread. Autonomous
reconcile = node lands the merged file + (optionally) a steer message; agent picks it up at
its next step. **No agent-facing inbox to poll.**

**Verify before build (1 item):** the POC proved *agent-writes-`merged` → node-reads-`upper`*;
node-side inbound relies on the **inverse** (*node-writes-`merged` → agent-reads*), which
should hold by the same `rshared` propagation but wasn't the exact case tested. ~10-min POC.

## 5. The load-bearing new pieces (what C1 lacked)

1. **Hydration manifest** (`path → base_seq`, written at startup) — needed by *both*
   base-aware capture (§3) and adopt-time diff3 (§4). The single most important missing
   piece; without it capture blind-appends and adopt can't 3-way merge.
2. **Per-container hydration subscription set** — the node polls the ledger only for the
   shared paths this container actually hydrated (the §9 "workspace/topic-scoped feed"),
   not all artifacts.
3. **`/atrium` read-only context projection** (§2A) — the node-maintained tree of chat +
   sibling transcripts + an artifacts view, append-tailed live; one shared copy per node.
   (Replaces the agent-facing `/incoming` — which, if kept at all, is node-internal staging.)
4. **Harness quiesce signal** — a lightweight "between-steps" hook so the node's write-through-
   `merged` never lands mid-read. *Replaces* the in-container 3-case adopter (now node-side, §4).

## 5A. Durability coverage — one mechanism, three destinations (by content class)

Capture is **not artifact-only**: it's one node-side mechanism that routes by content
class to the *right durability shape*. Forcing everything into the version-ledger is the
mistake (logs churn it; code fights its branch model).

| Content class | Destination | Why there |
|---|---|---|
| **Artifacts** (`proj-x/`, `shared/`) | version-**ledger** (CAS + chain + pointers + conflict-state) | edited, versioned, workspace-shared |
| **Code working-state** (repos) | **patch/diff artifact** (a `git diff HEAD` + untracked-file snapshot stored as a ledger blob; **no git refs created**) | keeps uncommitted repo work durable *without* writing git objects/refs into a repo a fleet shares (DECIDED 2026-06-20 — see below) |
| **Logs / transcripts** (`~/.codex`, `~/.claude`, …) | **chunked CAS blob + append-index** (NOT a version chain) | append-only; resume consumer; versioning is the wrong shape |

**The uncommitted-repo-work hole + fix (DECIDED 2026-06-20: patch-artifact, NOT a git
ref).** Repo files are excluded from the ledger (branch-incoherent — see §2). Git only
makes work durable *at commit*, so uncommitted edits are lost on crash/destroy (survive
pause only on a persistent repo volume). The fix must keep that work durable **without
confusing the agents that share the repo** — Gary's call: *any* automated git activity
(even a hidden ref) in a fleet-shared repo risks surprising agents/parallel sessions
(unexpected objects, refs, gc churn). So the node daemon captures WIP as a
**read-only patch/diff snapshot** stored as a ledger blob — it creates **zero git
objects or refs** the agent can see:
```
# pure-READ against the repo volume; writes nothing into .git, touches no ref/index/HEAD
git diff HEAD                       # tracked changes (binary-safe)
git ls-files --others --exclude-standard | xargs … # untracked, .gitignore-respected
→ bundle as a {repo, base_HEAD_sha, patch_blob, untracked_blobs} artifact in the ledger
```
**Recovery** = re-clone at `base_HEAD_sha`, then `git apply` the patch + drop in the
untracked files. **Trade-off (accepted):** not a faithful mirror of exotic git states
(in-progress rebase/merge, staged-vs-unstaged distinction, submodule state) — it's a
*recovery point*, not a clone; binary diffs are bulkier than a tree. **Why this over the
rejected git-shadow-ref (`commit-tree`→`refs/centaur/wip/*`):** the shadow-ref is
invisible to `git status/log/branch` but still *writes git objects* into the shared repo
and needs ref-prune/gc — exactly the automated-git-activity the decision rules out. The
patch path is pure-read → structurally can't surprise an agent. It runs over **disjoint
paths** from the artifact scan (repos vs the overlay upper) → no double-capture; shares
the node daemon's resources, egress, and pod→session attribution. **Overhead to manage:**
diff cost is O(changes) per heartbeat (cheap); store patches in the CAS (sha-dedup across
heartbeats); GC old WIP patches on a grace window like any blob.

**Transcripts** (the rollout JSONL) are *mechanically* capturable by the same node
file-watch — they're just not in `/workspace` and they're a *log*, so they route to the
log destination (chunked blob + append-index), feeding harness-resume, not the gallery.

## 5B. Storage layout & hydration — `lower` is a checkout, not a byte-merge

**The store is heterogeneous by class:**
```
ARTIFACTS   → S3 cas/<sha> blobs + PG ledger;  whole file = 1 blob;  chunked = manifest{chunk-shas} + N chunk blobs
CODE        → git objects on the FORGE/mirror (NOT our S3); uncommitted WIP = a patch-artifact in OUR cas/<sha> (no git refs)
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
| WIP working-copy snapshots | **`dura` (auto-commit to a shadow ref), jj (auto-commits the working copy)** | **BORROW the *durability* idea, NOT the git mechanism** — both auto-commit git objects (`dura` is also local-only/no-push → disqualified by no-ingress). DECIDED 2026-06-20: capture WIP as a **pure-read patch artifact (no git refs)** instead (§5A), so it can't confuse fleet-shared repos. |
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

**Recommendation — DONE: see `build-vs-buy-eval.md`** (the focused eval this section
called for; 5 cited research passes + 2 hand-computes + a user-story stress-test).
**Verdict: buy the *algorithm*, borrow the *pattern*, build the *glue* — no buy for the
whole** (the integration is the product; the one same-category competitor, Mesa, is
closed with undisclosed conflict internals). Concrete picks: **buy** `fastcdc-rs`
(chunker) + `xet-core` (large-file CDC, when >16 MiB lands) + **Vector** (capture/ship
daemon) + **Parquet/DuckDB** (working-history cold archive); **borrow** the segment+index
log-seal and the **pure-read patch-artifact** for WIP capture (DECIDED 2026-06-20 over a
git shadow-ref, which writes git objects → can confuse fleet-shared repos; dura is also
local-only/no-push → disqualified by no-ingress; jj-for-WIP = op-log tax for no gain); **build** the
pack-index+GC (~1–1.5k LOC, *same shape as the shipped `artifact-ledger-gc.ts` lease
worker*) and the lower-hydration (parallel-GET + node-local CAS cache + reflink — *not*
JuiceFS/CubeFS, which replace the store + add a cross-tenant metadata blast surface;
Mountpoint-S3 read-only is back-pocket-only). **No OSS jj cloud backend exists in 2026**,
so the own-CAS-ledger decision re-validates. v1 stays whole-object; un-defer triggers are
type-gated (CDC only when large-churny-binary storage dominates — 14–34× there, ~1× for
text).

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
| Inbound fetch + **node-side merge** (write-through-`merged`) + harness quiesce signal | **new** — redesigns C1; supersedes the in-container adopter (DECIDED 2026-06-20) |
| Hydration manifest + subscription set + **`/atrium` context projection** (append-tail) | **new** |

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
- **WIP patch-artifact fidelity** (§5A, DECIDED 2026-06-20) — capturing uncommitted repo
  work as a pure-read `git diff` patch (no git refs, so it can't confuse fleet-shared
  repos) is a *recovery point, not a clone*: exotic git states (in-progress rebase/merge,
  staged-vs-unstaged, submodules) aren't faithfully captured. Accepted trade-off.
- **Build-vs-buy eval — DONE 2026-06-20 (`build-vs-buy-eval.md`).** Buy
  `fastcdc-rs`/`xet-core` + Vector + Parquet/DuckDB; borrow the segment+index log-seal +
  the pure-read patch-artifact for WIP (no git refs, DECIDED 2026-06-20); build the pack-GC (same shape as the shipped
  `artifact-ledger-gc.ts`) + lower-hydration (parallel-GET+reflink, *not* JuiceFS). No OSS
  jj cloud backend exists → own-ledger re-validated; no buy for the whole (Mesa is the one
  closed competitor). v1 stays whole-object; CDC un-defer is type-gated (14–34× on large
  churny binaries, ~1× on text). *Three gaps surfaced for the build list:* autonomous
  stale-read reconcile trigger, delete-vs-edit resolution UX, lower-stability across resume.
- **Repo-`.md` UX — DECIDED 2026-06-20 (§2):** location-as-backing (git for repo files,
  ledger for artifact-namespace files), **no dual-store**; UX preserved by a polymorphic
  **Files surface** over both. The only *remaining* work is building that unified surface
  (git-backed source + git-commit write-back) — an Atrium UI task, not a design open.

## 8A. Open issues & risks — adversarial review (2026-06-20)

Two independent adversarial passes — an in-house critique + a **codex** pass (codex runtime
was available this time; both converged on ~12 of these, codex added the security-flavored
ones). Prioritized; CRITICALs **gate** the inbound node-write decision (§4) and the node-scan
(Track C4) before build. Provenance: **[B]** both, **[C]** codex-only, **[I]** in-house-only.

| # | Sev | Issue | Fix direction | Src |
|---|-----|-------|---------------|-----|
| 1 | **CRIT** | **Symlink/path escape** — agent symlinks `proj-x/leak→/etc/shadow`; the privileged host scanner follows it → exfil to S3 | `openat2(RESOLVE_BENEATH\|NO_SYMLINKS\|NO_MAGICLINKS\|NO_XDEV)` + `O_NOFOLLOW` + `fstat`→regular-files-only; symlinks stored as metadata, never followed | C |
| 2 | **CRIT** | **Echo loop + stale base** — node write-through-`merged` re-captured as an agent edit; `base_seq` is startup-only, never advanced after adopt → false conflicts | **per-path state record** `{base_seq, base_sha, upper_sha, applied_remote_seq}` + origin journal; node-merge IS the ledger txn, then apply bytes idempotently (fixes both) | B |
| 3 | **CRIT** | **Node-write race + ownership** — advisory quiesce is TOCTOU; root-written files unwritable by the uid-1001 agent | per-path **write-lease** (harness blocks artifact writes in the window) + atomic temp+rename + chown-to-agent | B |
| 4 | **CRIT** | **`/atrium` shared-per-node leaks channel/DM ACLs** — one shared tree bypasses per-pod ACL | per-ACL-group projection / server-side ACL behind the `atrium` tool; shared-per-node only for the *common* slice | B |
| 5 | MAJ | Conflict-`latest` markers → naive re-save silently clears the conflict | conflict-aware read (serve last-clean + a `conflicted` flag); resolve only via API against the conflict seq | B |
| 6 | MAJ | Append-tail wrong for chat (edits/deletes/redactions persist → secret re-disclosure) | re-rendered "current" view + raw-event jsonl; transcripts stay append-tail | B |
| 7 | MAJ | Change-feed `since=<seq>` ambiguous (`seq` is per-artifact) | global outbox id / WAL-LSN cursor (`artifact_changes(id bigserial,…)`) | C |
| 8 | MAJ | GC deletes conflict-jsonb side-blobs (mark-sweep marks only `blob_sha`) | normalize all blob refs to rows; GC honors unresolved conflicts + leases + outbox lag | C |
| 9 | MAJ | Upload↔commit non-atomic (read 404s / orphans) | `pending_blob` + conditional-create + verify-`HEAD` → then advance `latest` | C |
| 10 | MAJ | Cold-start hydration stampede (~4s@10k, ~40s@50k; lazy/manifest unbuilt) | tree-manifest + node CAS cache in v1; eager-size cap + admission backpressure | B |
| 11 | MAJ | No backpressure → `upper` ENOSPC under fast writers | dirty-byte budgets, lag metrics, harness backpressure, bounded upload queue | C |
| 12 | MAJ | metacopy=off copy-up amplification on large lower files | route large/append-heavy files out of the overlay artifact ns | B |
| 13 | MAJ | No atomic multi-file snapshot (inconsistent coupled sets) | commit-group / tree-manifest snapshot boundary; hydrate by snapshot id | B |
| 14 | MAJ | `/workspace` (frozen lower) vs `/atrium/artifacts` (latest) version skew | seq labels on both views; hide dup-latest for paths already in `/workspace` | B |
| 15 | MOD | Open FDs / watchers hide node writes from running tools | process-level invalidation on adopt (signal reopen/restart) | C |
| 16 | MOD | Rename fidelity (redirect xattr unreadable in POC) | downgrade to delete/create until proven; mount `redirect_dir=on`; test long paths | B |
| 17 | MOD | Persistent-upper node-affinity + non-identical-lower remount | Local PV + required node affinity; **fail-closed** on lower/manifest hash mismatch | B |
| 18 | MOD | reflink assumes XFS/btrfs (ext4→hardlink corrupts the shared lower) | require reflink FS at node admission; immutable hash-verified CAS cache; lower mounted RO | C |
| 19 | MOD | DaemonSet TCB / single-point-of-compromise per node | gate multi-tenant on VM-per-tenant; narrow scanner IAM to session prefixes; seccomp/AppArmor; split setup-privilege from steady-state scan | B |
| 20 | MOD | "Native large-file path" lacks multipart/backpressure (a 20 GB read blocks the node) | streaming multipart + size caps + per-node concurrency before claiming C3 closed | B |

**Two highest-leverage takeaways:**
1. **One root behind #2 / #3 / #5:** there is no single source of truth for *current base +
   byte-origin per path in the `upper`*. A per-path mutable state record
   (`current_base_seq` / `base_sha` / `upper_sha` / `applied_remote_seq`) + treating the node
   merge as the ledger-writing transaction (then idempotent byte-apply) fixes echo-loop +
   base-advance + conflict-clear **together**. Highest-value design change.
2. **Security was the in-house blind spot:** #1 (symlink escape) + scanner-IAM/seccomp
   narrowing (#19) must gate the privileged node component — a privileged *host* process
   resolving agent-controlled paths is the scariest surface in the design.

**Status:** CRITICALs #1–#4 are pre-build gates for §4 / Track C4. Research + POC underway
(openat2 / overlayfs / reflink facts; symlink-escape + node-write + echo-loop POC on the
centaur image). Open product calls: ACL-projection model (#4), conflict-read semantics (#5),
chat-projection form (#6), and which issues are v1-blocking vs deferred.

## 9. Relationship to other docs

- `cas-ledger-build-plan.md` Track C4 — the outbound/capture half + the overlay
  provisioning; this doc is its inbound complement + the unified picture.
- `inbound-sync-spec.md` — **superseded** by §4 here (in-container daemon → node-side
  fetch/stage; stdin-poke demoted to optional notify).
- `agent-data-architecture.md` — the overlay execution model + merge-class/conflict-state
  this builds on.
