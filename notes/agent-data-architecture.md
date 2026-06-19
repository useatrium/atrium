# Agent Data Architecture — logs, artifacts, workspaces

Status: **DRAFT, converged on the architecture; one build-vs-adopt spike open**
(updated 2026-06-19). Captures the research, explored ideas, discussion + Gary's
feedback, and the working conclusions.

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
- **Store backing (lakeFS vs own CAS-ledger): OPEN** → `spike-artifact-store.md`.

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
- **Capture/promote:** sandbox POSTs out to api-rs → durable store (built today:
  A1 egress policy + B1 offload).
- **Mid-session inbound** (human/other-agent edited a shared artifact): there is
  **no push into the sandbox** —
  - **lazy pull-on-access:** the daemon GETs the current version when the agent
    reads it (covers most cases);
  - **invalidation over the outbound stream:** "X advanced under you" rides the
    *already-held* outbound event stream (the one carrying steers/HITL), then the
    daemon pulls (egress).
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
  pointers/ledger/lineage/index → Postgres. **Backing TBD by the spike** (lakeFS
  vs. extend the existing `session_artifacts` CAS-ledger).
- **Sync:** egress-only (hydrate-GET, capture-POST, lazy-pull, invalidation over
  the outbound stream). Mid-session inbound = new Centaur work.
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

- **Store backing spike** — `spike-artifact-store.md` (lakeFS vs own CAS-ledger).
- **Mid-session inbound sync** — new Centaur work (egress pull + invalidation on the
  outbound stream); until then, freshness = at-promote.
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
