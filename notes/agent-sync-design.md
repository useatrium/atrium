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
- **Carry-over trap:** an agent writing a deliverable *inside* the repo volume isn't
  captured (repo is git's, separate). Mitigation = convention + agent instruction: write
  deliverables to the artifact namespace (`proj-x/`, `shared/`). Unchanged from the
  repo-exclusion finding.

## 3. Outbound (capture) — node-scan of the upper

Per C4: a privileged **node DaemonSet** (one per node, O(nodes)) scans each container's
overlay `upper` (= the changed set, O(changes)), interprets overlay encoding
(regular→created/modified, char-dev 0/0→delete, `trusted.overlay.redirect`→rename), reads
bytes, and POSTs **direct to Atrium S3** (bypasses the `bytea` ceiling → large-file path).
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
- **k8s `mountPropagation: Bidirectional` wiring** — kernel substrate POC-confirmed;
  the YAML wiring + init-ordering still to confirm on a real Linux node (documented
  feature). Tried in kind locally; blocked by Docker-Desktop-on-Mac image plumbing, not
  design — finish on the real node where the deploy lives.
- **Multi-tenant blast radius** — the node sync daemon reads all pods' uppers on its node
  → VM-per-tenant (hypervisor boundary; per-tenant node → per-tenant daemon).

## 9. Relationship to other docs

- `cas-ledger-build-plan.md` Track C4 — the outbound/capture half + the overlay
  provisioning; this doc is its inbound complement + the unified picture.
- `inbound-sync-spec.md` — **superseded** by §4 here (in-container daemon → node-side
  fetch/stage; stdin-poke demoted to optional notify).
- `agent-data-architecture.md` — the overlay execution model + merge-class/conflict-state
  this builds on.
