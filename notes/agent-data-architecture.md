# Agent Data Architecture — logs, artifacts, workspaces

Status: **DRAFT, architecture converged; store backing DECIDED (own CAS-ledger)**
(updated 2026-06-25). Captures the research, explored ideas, discussion + Gary's
feedback, and the working conclusions.

> **UPDATE 2026-06-25:** the storage implementation is one Atrium CAS-ledger write path, not
> a long-lived `session_artifacts` staging/offload layer. Agent capture, human
> write-back, uploads, hydration, and app publish all converge on `cas_blobs` with
> S3-durable bytes before non-delete versions commit. `session_artifacts` remains
> useful historical scaffolding from the first capture/offload build, but the
> hard-cut branch deletes it rather than adding a third mechanism.

Sister docs:
- `spike-artifact-store.md` — the open lakeFS-vs-own-CAS-ledger spike (decides the
  store backing).
- `agent-session-resume-and-storage-plan.md` — resume/sleep/harness strategy.
- `harness-resume-workstream.md` — harness-resume checklist + Codex/Claude POC.
- `artifacts-followups.md` — current artifact-capture build (A1/A2/B1).
- `data-lifecycle.md` — events/files/drafts retention.

## Scope & framing

How agent-session data is stored, versioned, and made accessible across **teams of
humans + many agents working in parallel with human oversight**. Three shapes:
(1) conversation/agent logs, (2) artifacts (files/datasets/reports/docs, **edited
by both humans and agents**), (3) code/dev workspaces. Plus chat logs (already
Postgres) and ergonomic corpus access for agents.

**Deprioritized:** instantly-forkable sessions (Morph/E2B/Firecracker/CRIU) —
reference class only. Resume is **file-based** (proven by the harness-resume POC),
so a "fork" = copy-JSONL + CoW-clone + `--resume`; memory-snapshot forking is a
latency optimization, not a correctness requirement.

## Decisions (Gary, 2026-06-18/19)

- **Actively managed substrates: artifacts + collaborative docs.** Code =
  coordinate around git (git-on-forge canonical; Atrium does NOT reinvent VCS).
  Structured data = files-as-artifacts now (below); shared live DBs deferred/BYO.
- **Capture = hybrid auto-detect → promote.**
- **Agent-UX first; do NOT impose a commit/VCS workflow.** Ceremony-free write
  path + a VCS-*shaped* queryable substrate underneath.
- **Reconciliation = plain jj-style conflict-state** (both sides recorded, resolved
  later). Human-byte-sticky override **parked** for now.
- **Drop in-container jj as an engine** — use jj's *model* (content-addressing,
  change-ids, conflict-as-state) in the durable store; don't run jj in the sandbox.
- **CDC/chunk-dedup deferred** — not needed for v1; whole-object storage is fine;
  may add later for large/churny media.
- **Store backing = own CAS-ledger** (DECIDED by live spike 2026-06-19, 39–29 over
  lakeFS; lakeFS lost on conflict-fit + ops + paywalled RBAC). The 2026-06-25
  refinement landed as a hard cut to a single Atrium CAS path: no durable dependence on
  `session_artifacts`, artifact offload, or Centaur proxy fallback. See
  `spike-artifact-store.md` and `cas-ledger-build-plan.md` §3b-§3d.

## Revised decisions (2026-06-19, design pass after CAS-ledger v1)

A conversation after v1 landed settled the sharing / identity / notes / sync opens.
Full record: `cas-ledger-build-plan.md` §10. Deltas to the design above:

- **Identity = workspace-scoped, scope-as-reserved-path-prefix.** The key is
  `(workspace, canonical_path)` — session/channel are provenance, not the key. Atrium
  selects one active shared leaf and materializes it at `~`, so generic writes like
  `report.md` land in the right channel/task scope without agent prompting. Scope folds
  into canonical prefixes the filter reads: `shared/global/...`,
  `shared/channels/<active-channel-id>/...`, future `shared/projects/<project-id>/...`
  once projects are product objects with ACLs, and `scratch/<session-id>/...` for
  session-scoped durable artifacts. Current code rejects project and non-active channel
  prefixes instead of accepting arbitrary ids.
  Access follows longest matching prefix; agents may create subdirs inside granted leaves,
  but not new scopes by naming folders.
- **Notes → artifact-canonical** (reverses the daily-driver chat-canonical-notes
  model). Chat = input + view; agents edit notes as artifacts. The voice/mobile
  braindump is preserved by an **append write-mode** → append-only log artifact
  (never conflicts), distinct from the **edit mode** (conflict-state).
- **Conflict model: jj-style state is what's BUILT** — conflicts are first-class
  committable versions (`latest` advances, never blocks), *not* git-style blocking.
  node-diff3 is just the merge algorithm. **CRDT is NOT the tracking model** (agents
  emit file overwrites not CRDT ops; CRDT convergence ≠ correctness; it wants a live
  connection, anti no-ingress). CRDT stays a narrow **opt-in human-editor
  live-co-edit fast-path** committing back to the chain. (Firms up the prior
  "CRDT only opt-in" line into a hard boundary.)
- **diff3 gated by merge-class:** binaries → `immutable-data` (never diff3);
  structured-serialized (JSON/YAML/CSV/`.ipynb`) → diff3-unsafe → whole-file
  conflict-state; line-text (code, md prose) → diff3 OK.
- **Code repos excluded from the shared-artifact pool** — code = coordinate around
  git; a repo in two containers is git's to merge, never artifact-synced between
  them. Filter excludes anything under a git working tree (extends the `.git/`-only
  ignore); deliverables are written outside repo roots into the shared namespace.
- **Mid-session inbound (C1) is IN SCOPE** (not "freshness=at-promote"): target is a
  running agent seeing an edit within seconds; egress-poll daemon (floor) + stdin
  poke (latency cut). Autonomous reconcile = **auto-rebase at a safe checkpoint**,
  never hot-swap mid-write. Mechanism = **stdin directive over the attach pipe**,
  NOT an outbound stream (see the corrected sync section below).
- **Capture mechanism = DECIDED: overlay-upper node-scan** (2026-06-20, Gary:
  "scalable/permanent, not an MVP"). The overlay model is **reinstated — with the
  privilege relocated**: the *runtime* provisions a per-pod overlay (lower = base +
  deps + repo RO; upper+work on a session-keyed persistent node volume; `merged` bind
  into the hardened agent via `mountPropagation: Bidirectional`), and a **node
  DaemonSet** (O(nodes)) scans each upper (O(changes)) — delete/rename fidelity, zero
  agent footprint, direct-to-S3 large files. This supersedes both the dropped
  *agent-mounts-overlay* (no caps) and the in-container poll/inotify (doesn't scale:
  per-UID `max_user_watches`). Forces 4 commitments — repo-in-RO-lower, torn-read via
  changed-during-read + `/proc`-fd gating (rsync/restic pattern), session-keyed
  persistent upper (also upgrades resume), and the **`mountPropagation` linchpin**
  (verify on a real Linux node before build). Multi-tenant blast radius →
  **VM-per-tenant** (per-tenant node = per-tenant DaemonSet; hypervisor boundary, not
  software policy). Full design: `cas-ledger-build-plan.md` **Track C4** (+ §10.7b).

## The core model

Three shapes, three merge behaviors — don't unify into one consistency model.

| Shape | Backing | Merge model |
| --- | --- | --- |
| Conversation/agent log | Postgres event log (+ rollout-JSONL blobs in S3) | append-only (no merge) |
| Artifacts (incl. docs) | S3 content-addressed blobs + Merkle manifest + Postgres ledger | per-object **merge-class** |
| Workspace FS | local overlay in the container; durable via capture | git (code) |

**Append-only vs "I edited an .md"** resolves as Git's model: immutable content-
addressed blobs + mutable refs. An edit = new blob + advanced pointer; old version
retained. "Aged-ness" = which pointer you followed (`latest`/`official`/pin). The
right *data structure* is a content-addressed Merkle DAG; **S3 is just the backing.**

**Per-object merge-class:** `immutable-data` (no merge — datasets, media),
`mergeable-doc` (3-way, jj-style conflict-state; CRDT only for opt-in live co-edit),
`derived-output` (regenerate-only; manual edit = anomaly).

## Execution & capture (in-container)

> **UPDATE 2026-06-20 — overlay REINSTATED at the runtime level (Track C4).** The
> banner below dropped *agent-mounts-overlay* (correct: no caps in the sandbox). The
> decided design relocates the privilege: the **runtime** provisions the overlay and
> a **node DaemonSet scans the upper** — the agent never mounts and stays hardened.
> The "free diff / upper-is-the-diff" intent below is therefore back on, just owned
> by the node, not the agent. See `cas-ledger-build-plan.md` Track C4.
>
> **SUPERSEDED 2026-06-19 — the overlay was DROPPED.** The sandbox is non-root with
> `drop:[ALL]` caps, so an overlay mount needs `CAP_SYS_ADMIN` (`EPERM`) and GKE-COS
> blocks the userns escape. Today's workspace is a plain **`git clone --shared`**;
> the "free diff" = `git status`/`git diff` over the session branch; capture is the
> in-process 2.5 s watcher. The overlay description below is retained as original
> design intent only. (See `cas-ledger-build-plan.md` §4/§5b.)

**Execution FS = a real local overlay per agent** (NOT object-FUSE — FUSE dies on
atomic rename, lock files, partial writes, fsync, many tiny files):
```
lowerdir = base image + deps + hydrated shared artifacts (read-only)
upperdir = this agent's changes (private, writable)
merged   = /workspace  ← agent edits here, full POSIX, no permission errors
```
A write to a shared artifact **copies-up** into the private upper (always
succeeds → no EROFS); the shared base is never mutated; the change becomes a new
version. The overlay gives the **diff for free** (upperdir = changed set; no
whole-tree scan) and structurally excludes the base (deps/toolchains) from capture.

**In-container footprint = a sync daemon + git** (no jj engine):
- watches the upper → captures (egress POST) on a heartbeat/checkpoint;
- holds the outbound subscribe stream (invalidation);
- lazy-pulls artifacts on access (egress GET);
- `git` runs on top for the code shape (canonical to forge; `.git` ignored by
  capture).

**Two tiers of "version" (granularity, not a dir):**
- **Working history** — fine-grained checkpoint snapshots of the upper (autosave/
  crash-safety/undo/Changes surface/resume). Abundant, dedup'd, GC'd hard. Not
  user-facing.
- **Promoted versions** — `v1/v2/v3` consumers pin. Promotion = **filter-pass at a
  checkpoint** (no mandatory `/outputs` dir; the artifact-vs-junk filter is the
  gate). Add a deliverable-scope/`official`-curation later only if filter-based
  proves noisy.

**Commits are checkpoint-driven, not turn-driven** (turns run for days): working-
history flushes on a **heartbeat** (~minute / idle / size-threshold); promoted
versions fire on **semantic checkpoints** (plan-step, milestone, explicit, turn-
end). Checkpoints double as resume/sleep + re-grounding points.

**Basic flow needs zero agent cooperation** (auto-capture + filter-pass promote).
The CLI/API is the *power tool* for intent (name, metadata, mark-official, pin,
revert, diff, subscribe).

**Promote ≠ a VCS commit** — it's the coarser act of pushing a state out to the
durable store as a versioned artifact, at the cadences above.

## Filtering (what gets captured/promoted)

Layered, configurable per workspace mode (source-repo / data-analysis / codegen):
- **Path/name globs (gitignore-style) — by location, the workhorse:** `.git/`,
  `.jj/`, `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`, `target/`,
  `.cache/`, `*.o`, `*.pyc`, `*.class`, `.DS_Store`, editor swap.
- **Type allow/deny — by what it is, the artifact-vs-junk nuance:** KEEP code, md,
  png/jpg/svg/pdf, csv/parquet/json, notebooks; DROP junk-binaries (`.so/.whl/.a`).
  Axis is **artifact-vs-junk, NOT binary-vs-text** (a PNG is a binary keeper).
- **Secrets detector — orthogonal:** name/path deny + content entropy/key scan.
- **Size = a routing signal, not a filter:** large media is kept but routed to
  **CAS, not a VCS blob store**.

## Storage backing (S3-shaped, split in two)

The single most important fact — confirmed by lakeFS and Dolt: **immutable
content-addressed bytes + Merkle metadata → object store (S3/MinIO); mutable
refs/branches/staging/ledger/index → a transactional DB (Postgres/DynamoDB).**
Object stores have no atomic compare-and-set; refs can't live there. **lakeFS
Graveler** (Merkle SSTable ranges/meta-ranges in S3 + refs in KV) is the closest
battle-tested prior art — hence the spike.

**Large media:** keep (artifact-vs-junk, not size); CAS + multipart (100MB switch,
5GB single-PUT cap); pack chunks into ≤64MB blocks. **CDC dedup deferred to
post-v1** (helps datasets/checkpoints 30–85%; ≈0 for re-encoded video/compressed;
gate by type when added). Shard keys by high-cardinality prefix (S3 per-prefix
write throttle + Merkle keyspace locality).

## Cross-container sync under no-ingress (the Centaur constraint)

Centaur sandboxes are **no-ingress** — nothing connects *into* them — so **all
sync is sandbox-initiated egress**:
- **Startup hydration:** sandbox GETs its workspace from the durable store.
- **Capture/promote:** sandbox/node POSTs out to Atrium's internal capture/write-back
  route, which writes durable CAS/S3 bytes before committing a ledger version. The
  older sandbox → api-rs staging → Atrium offload path was proven, but is not the
  target durable store.
- **Mid-session inbound** (human/other-agent edited a shared artifact): there is
  **no push into the sandbox** —
  - **lazy pull-on-access:** the daemon GETs the current version when the agent
    reads it (covers most cases);
  - **invalidation via a stdin directive (CORRECTED 2026-06-19):** there is **no**
    held outbound subscribe stream — a running agent's only inbound channel is
    **stdin over the k8s attach pipe**. So "X advanced under you" is a **new stdin
    directive** (`{type:artifact.sync,path,sha}`) the control plane pushes, or
    (primary) an **egress-poll daemon** polling a change-feed; then the daemon GETs
    the bytes (egress). See `inbound-sync-spec.md`.
- Reconciliation happens **at promote time in the durable ledger** (fork →
  conflict-state). Agents never see each other's *uncommitted* edits (private
  working copies). We **never hot-swap a file under a running agent** — notify, it
  decides whether to rebase.
- True simultaneous co-edit (rare) = **CRDT opt-in fast-path** (sync ops over a
  connection, commit back to the chain) — separate mechanism.

**Honest gap:** capture-*out* is built; **mid-session inbound sync (pull-updated-
artifacts-into-a-running-sandbox + the invalidation channel on the outbound
stream) is NEW Centaur work.** Until it exists: hydrate-at-start + capture-out +
reconcile-at-promote, with cross-container freshness = "you find out at your next
promote." Build the live invalidation channel when better freshness is needed.

## Off-the-shelf for the sync? (the question that started the jj thread)

No single off-the-shelf system does the *cross-container workspace sync* for this
exact combination (**no-ingress + large binaries + versioned-with-merge + multi-
shape + agent semantics**). The closest conceptual match — a continuous-sync VCS
cloud backend (jj's) — is exactly the closed-source Google piece. No-ingress
disqualifies most sync products (Syncthing/Mutagen/P2P need reachability; webhooks
push the wrong way); only pull/egress-API models survive.

**Buyable per-piece:** versioned store over S3 with branch/merge → **lakeFS**
(egress-API; caveats: whole-file merge, no CDC, run-it-yourself); code shape → git
remotes (already); live doc co-edit → Yjs+provider; structured-data local-first →
ElectricSQL/PowerSync; bulk hydrate/capture → rclone/Mountpoint. **Must build (the
glue):** the egress-only capture daemon, the no-ingress invalidation channel, the
artifact-vs-junk policy, promotion/lineage/freshness, and (later) CDC. The
integration is the product.

## jj evaluation (used as a model, not run in-container)

jj's model fits beautifully — working-copy auto-committed (no commit ceremony),
anonymous commits, **stable change-ids**, **first-class conflicts (operations never
block)**, op-log + undo. But:
- "jj the whole workspace on S3 with binaries" is **not buildable off-the-shelf**:
  the S3 backend + caching daemon AND the CDC large-file layer are Google's closed-
  source pieces; no LFS/dedup; op-log grows per-command, not auto-GC'd; concurrent
  invocations race into divergent op-heads; sub-1MiB build outputs auto-track.
- And given a separate durable store + git-for-code + overlay-for-diff, **running
  jj in the container is redundant** and adds op-GC/serialize/watchman tax.

**Verdict:** don't run jj. Adopt its *model* (content-addressing, change-ids,
conflict-state) in the durable ledger; the agent's "explore all my artifacts"
affordance = read-only mount + query API over the durable store, jj-*shaped* in
semantics.

## Multi-actor synthesis (5 user-story clusters)

Code repos / structured data / docs / artifact pipelines / oversight converged:
1. **The merge problem is mostly a freshness/invalidation problem** — the danger is
   the detached in-container cache with no invalidation channel.
2. **One spine: the append-only event log** is the system of record (Atrium's
   `session_events`). Sessions form a DAG (handoff + rewind branches).
3. **Immutable content + explicit moveable pointers; runtime-captured provenance;
   advisory push-based invalidation** (cascades staleness, never auto-regenerates).
4. **Split consistency by path:** data plane eventual (staleness/provenance in-
   band); control loop synchronous/idempotent (<2s steers/approvals/rewrites); one
   small CRDT for the advisory coordination board.
5. **Agent ergonomics:** local FS for execution; grep-mount + query/**subscribe**
   over one access-controlled namespace; emit typed events out / drain one ordered
   inbox in; humans and agents read the **same** projections, write the **same**
   event families. Subscribe/push, not poll.

## Recommended design (convergent)

- **Execution:** local overlay per agent; edit freely, no ceremony, no EROFS.
- **In-container:** a sync daemon (watch upper → egress capture; hold outbound
  subscribe; lazy pull-on-access) + git for code. No jj engine.
- **Capture:** watcher on the upper (free diff), checkpoint-driven, two-tier;
  hybrid auto-detect→promote = filter-pass at checkpoints.
- **Durable store:** content-addressed blobs + Merkle metadata → S3/MinIO; refs/
  pointers/ledger/lineage/index → Postgres. **Backing = own CAS-ledger** (decided
  2026-06-19; storage hard-cut 2026-06-25) — one Atrium CAS write path for
  capture/write-back/uploads/app publish, with `s3_key` present before non-delete
  versions commit. `session_artifacts`/offload/proxy fallback are removed instead
  of preserved as a second store.
- **Sync:** egress-only (hydrate-GET, capture-POST, lazy-pull, invalidation via a
  **stdin directive** / egress-poll daemon — *not* an outbound stream). Mid-session
  inbound (C1) is **in scope** (target: running agent fresh within seconds).
- **Media:** CAS + multipart (CDC deferred).
- **GC:** mark-and-sweep + grace window from day one; expire dead session branches;
  compact working-history.
- **Search:** Postgres metadata → FTS → vector (gated); promoted artifacts only.
- **Access:** API-first (provenance/freshness/subscribe/ACL spine); read-only
  grep-mount as a fast-follow.
- **Docs:** merge-class `mergeable-doc`, suggestion-then-approve default, event sync
  (seconds); CRDT live-edit only as an opt-in fast-path committing back to the chain.
- **Structured data:** SQLite/dataset *files* ride the artifact store now; shared
  live DBs deferred/BYO.

## Open items

- ~~Store backing spike~~ — **RESOLVED: own CAS-ledger** (`spike-artifact-store.md`).
- **Mid-session inbound sync (C1) — IN SCOPE (design pass 2026-06-19).** Egress-poll
  daemon + **stdin-directive** invalidation (NOT an outbound stream); reconcile =
  auto-rebase at a safe checkpoint. The gating item for live cross-container collab;
  spec in `inbound-sync-spec.md`, decisions in `cas-ledger-build-plan.md` §10.
- **CDC for large media** — deferred to post-v1.
- **Human-byte-sticky reconciliation** — parked; revisit if jj-style proves
  insufficient for human+agent doc collisions.

## Sources

Forkable/CoW: Morph, E2B (github.com/e2b-dev/infra), Firecracker snapshotting,
CRIU. Data backings: lakeFS Graveler (docs.lakefs.io/understand/how/versioning-
internals), Dolt prolly-trees, Xet/FastCDC (huggingface.co/blog/from-files-to-
chunks; USENIX ATC'16), Neon branching. S3 perf (docs.aws.amazon.com/AmazonS3),
S3 PUT bench (topicpartition.io). jj: docs.jj-vcs.dev (architecture/roadmap/git-
compatibility), jj-vcs/jj issues #80 (LFS)/#2865 (CDC)/#1841/#4545/#6830, LWN
958468.
