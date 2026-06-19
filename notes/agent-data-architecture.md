# Agent Data Architecture — logs, artifacts, workspaces

Status: **DRAFT, converged on the storage/capture/execution layer** (updated 2026-06-19).
A few semantic defaults remain open (flagged at the end). Captures the research,
the explored ideas, the discussion + Gary's feedback, and the working conclusions.

Sister docs:
- `agent-session-resume-and-storage-plan.md` — resume/sleep/harness strategy.
- `harness-resume-workstream.md` — harness-resume checklist + Codex/Claude resume POC.
- `artifacts-followups.md` — the current artifact-capture build (A1/A2/B1).
- `data-lifecycle.md` — events/files/drafts retention.

## Scope & framing

How agent-session data should be stored, versioned, and made accessible across
**teams of humans + many agents working in parallel with human oversight**. Three
data shapes: (1) conversation/agent logs, (2) artifacts (files/datasets/reports,
**edited by both humans and agents**), (3) code/dev workspaces. Plus chat logs
(already Postgres) and giving agents ergonomic access to the whole corpus.

**Deprioritized:** instantly-forkable sessions (Morph/E2B/Firecracker/CRIU) —
researched as a reference class only. Key reason it's not needed: resume is
**file-based** (proven by the harness-resume POC), so a "fork" is copy-the-JSONL +
CoW-clone-workspace + `--resume`; memory-snapshot forking is a latency
optimization, not a correctness requirement.

## Decisions made (Gary, 2026-06-18/19)

- **Actively managed substrates: artifacts + collaborative docs.** Code =
  coordinate around git (git-on-forge canonical, Atrium adds a freshness/
  coordination layer, does NOT reinvent VCS). Structured data (DBs/tables) =
  deferred / bring-your-own for now.
- **Capture = hybrid auto-detect → promote** (watcher auto-captures into a
  per-session holding area; promotion mints durable named versions).
- **Agent-UX first**, then clean semantics for cross-container human+agent artifact
  editing. Do NOT impose a commit/VCS workflow on the agent.
- **Ceremony-free write path + VCS-shaped *queryable* substrate** — the agent just
  edits files; the rich version/history/diff/merge model lives underneath and is
  *queried* when wanted, not imposed.

## The core model

Three shapes, three merge behaviors — don't unify into one consistency model.

| Shape | Backing | Merge model |
| --- | --- | --- |
| Conversation/agent log | Postgres event log (+ rollout-JSONL blobs in S3) | append-only (no merge) |
| Artifacts (incl. docs) | S3 content-addressed blobs + Merkle manifest + Postgres ledger | per-object **merge-class** (below) |
| Workspace FS | local overlay in the container; durable via capture | git/3-way (code) |

**Append-only vs "I edited an .md" resolves as Git's model:** immutable
content-addressed blobs + mutable refs. An edit = new blob + advanced pointer; old
version retained. "Aged-ness" = which pointer you followed (`latest`/`official`/a
read-time pin). The right *data structure* is a content-addressed Merkle DAG; **S3
is just the blob backing under it.**

**Per-object merge-class** (declared per artifact): `immutable-data` (no merge,
version-only — datasets, media), `mergeable-doc` (3-way, **human bytes sticky**,
agent edits to human regions become proposals; suggestion-patches default, CRDT
only for live co-edit), `derived-output` (regenerate-only; manual edit = anomaly).

## Execution & capture

**Execution FS = a real local overlay per agent** (NOT object-FUSE — FUSE dies on
atomic rename, lock files, partial writes, fsync, many tiny files):
```
lowerdir = base image + deps + hydrated shared artifacts (read-only)
upperdir = this agent's changes (private, writable)
merged   = /workspace  ← agent edits here, full POSIX, no permission errors
```
This solves the "agent hits EROFS editing a shared artifact" problem: a write
**copies-up** into the agent's private upper (always succeeds); the shared base is
never mutated; the change is captured as a new version. The overlay also gives the
**diff for free** — the upperdir *is* the changed set, so capture needs no
whole-tree scan. The base (deps/toolchains) is structurally excluded from capture.

**Two tiers of "version":**
- **Working history** (watcher-driven, fine-grained, internal): autosave / crash-
  safety / the Changes surface / resume checkpoints. Abundant, dedup'd, GC'd hard.
  *Not* user-facing versions.
- **Artifact versions** (promotion-driven, coarse, meaningful): the `v1/v2/v3`
  consumers pin. Promotion = rule-based (output-scope + artifact-vs-junk policy) or
  explicit (`atrium publish --as X`).

**Commits are checkpoint-driven, not turn-driven** (turns can run for days):
- working-history flushes on a **heartbeat** (periodic/idle/size-threshold) — a
  3-day loop still gets continuous snapshots;
- promoted versions fire on **semantic checkpoints** (plan-step done, milestone,
  explicit publish, or turn-end).
Checkpoints double as resume/sleep points and re-grounding points (a long-runner
must re-check, via subscribe/invalidation, that its base hasn't drifted).

**Version identity & surfacing:** blobs keyed by sha256 (free exact-dup dedup);
each artifact name has a version chain in the Postgres ledger `(name, seq, sha,
author, base_version, changeset/turn, time, status)`; pointers (`latest`/
`official`/pins) select current; surfaced in the UI (history/diff) and via the API
in-band `(content, version, status, provenance)`.

**Basic flow needs zero agent cooperation** (auto-capture + auto-promote). The
CLI/API is the *power tool* for intent: naming, metadata, mark-official, pin,
revert, diff, subscribe.

## Storage backing (S3-shaped, split in two)

The single most important architectural fact — confirmed by **lakeFS** and
**Dolt**: **immutable content-addressed bytes + Merkle metadata → object store
(S3/MinIO); mutable refs/branches/staging/ledger/index → a transactional DB
(Postgres/DynamoDB).** Object stores have no atomic compare-and-set; refs can't
live there. **lakeFS Graveler** (Merkle SSTable ranges/meta-ranges in S3 + refs in
KV) is the closest battle-tested prior art.

**Large media:** keep (artifact-vs-junk, not size); CAS + multipart (100MB
switch, 5GB single-PUT cap); pack chunks 64KB→≤64MB blocks (avoid many-tiny-
objects). **Gate FastCDC dedup by type:** datasets/checkpoints/incrementally-edited
files dedup ~30–85% (Xet: GPT-2 53%, a dataset 60%); re-encoded video/compressed/
encrypted ≈ 1–2× (skip — pure overhead). Encrypt *after* chunking.

**Key design for scale:** shard keys by a high-cardinality prefix (hash/session
first) — serves both S3's per-prefix write throttle AND Merkle keyspace locality.

## Latency budget

| Operation | S3 Standard | MinIO/NVMe | Note |
| --- | --- | --- | --- |
| Agent edit loop | — | — | **local overlay: µs–ms** (S3 not on hot path) |
| Capture → durable, small | p50 ~70ms / p99 ~137ms | single-to-tens ms | per-object floor paid each time |
| Capture → durable, GB media | ~size ÷ ~90MB/s/conn (s/GB), less w/ parallel multipart | NIC/disk-bound | multipart @100MB |
| Cold cross-container read | ~100–200ms first-byte (~20ms warm) + transfer | tens ms | instant if already hydrated locally |
| Metadata/history query | sub-ms–10ms indexed; low-100s ms broad | same | refs/ledger in Postgres |
| Search | metadata <10ms; FTS <30ms@500M; vector ~1.5ms p50@1M | same | in-traversal filtering for hybrid |

## Metadata growth & GC

- Merkle keeps per-commit metadata **O(changed), not O(tree×versions)** — lakeFS
  ≥99% block reuse at 20 commits/day; Dolt "scales with changes."
- **Locality caveat:** scattered writes collapse sharing — Dolt measured
  425KB/day → 26MB/day (68×). Partition keys for locality.
- **Grows unbounded** (Merkle bounds delta-per-commit, not cumulative): history,
  op/event logs (a Dolt journal hit 271GB/48h), and **autosave snapshots** (tiny
  frequent writes = ~10× garbage — our working-history tier is the risk).
- **GC is mandatory from day one:** reachability mark-and-sweep + grace window;
  aggressively compact working-history; **expire dead session branches fast**
  (abandoned branches pin storage until retention clears all ancestry).
- Search index: vector memory is the cost driver (~4.6GB/1M@768d → ~460GB@100M;
  pgvector ≤~1–5M then a dedicated engine). Index only *promoted* artifacts.

## jj (Jujutsu) evaluation

Gary's "more like jj than git" instinct is right — jj's model fits beautifully:
working-copy-is-auto-committed (no commit ceremony to impose), anonymous commits,
stable change-IDs (durable logical-change handle across rewrites), **first-class
conflicts (operations never block — huge for agent fan-out)**, op-log + undo.

**But "jj the entire workspace on S3 with binaries" is NOT buildable off-the-shelf
today:**
- No S3/object-store backend exists open-source — Google's cloud backend + caching
  daemon are closed-source; you'd write `Backend`/`OpStore` against S3 in Rust +
  your own sync protocol.
- **No large-file story** — no LFS/CDC/dedup, whole-file blobs; GB media/builds
  bloat; reclamation is manual `op abandon` + `util gc`, irreversible once pushed.
- **Op-log grows per-command** (not per-commit) and isn't auto-GC'd — an agent
  firing thousands of commands bloats it.
- **Concurrent invocations race into divergent op-heads** (#6830) — serialize jj
  per repo.
- Auto-snapshot footgun: sub-1MiB build outputs auto-track unless `.gitignore`'d
  first. Snapshot ~150ms/command (Chromium); needs watchman (fragile at scale).

**Verdict:** don't bet storage on jj-on-S3. If used at all, jj is a **local
per-container working-tree engine** for code/text ergonomics, with git objects
pushed to S3 out-of-band — never the durable cross-container store. The durable
shared substrate stays CAS+S3+Postgres (lakeFS-shaped) and can be made jj/git-
*shaped in query semantics* (incl. conflict-state versions for ceremony-free
reconciliation) without running jj.

## Multi-actor synthesis (5 user-story clusters)

Five independent explorations (code repos / structured data / docs / artifact
pipelines / oversight) converged:

1. **The merge problem is mostly a freshness/invalidation problem** — the dangerous
   artifact is the detached in-container cache with no invalidation channel.
2. **One spine: the append-only event log** is the system of record (Atrium's
   `session_events`). Sessions form a DAG (handoff + rewind branches). Everything
   else is a projection or an interrupt channel.
3. **Immutable content + explicit moveable pointers**; provenance captured by the
   runtime (not agents); **advisory push-based invalidation** that cascades
   staleness but never auto-regenerates.
4. **Split consistency by path:** data plane eventual (staleness + provenance
   in-band); control loop synchronous/idempotent (<2s steers/approvals/rewrites,
   injected at checkpoints); one small CRDT only for the advisory coordination
   board.
5. **Agent ergonomics:** local FS for execution; grep-mount + query/**subscribe**
   over one access-controlled namespace for cross-actor read; agents emit typed
   events out / drain one ordered inbox in; humans and agents read the **same**
   projections and write the **same** event families. Subscribe/push, not poll.

## ChatGPT-proposal assessment (the FS-capture design Gary shared)

Correct and adopted for the *single-agent execution-FS + capture* primitive (local
FS + watcher → CAS + manifest; FUSE only as adapter). It's the bottom of this
stack. Its gaps — real cross-actor merge, bidirectional human editing, cross-actor
freshness, non-file shapes — are exactly what the 5 clusters + the overlay/two-tier
model above fill.

## Recommended design (convergent)

- **Execution:** local overlay per agent (read-only base lower + private upper);
  agent edits freely, no ceremony, no EROFS.
- **Capture:** watcher on the upper (free diff), checkpoint-driven, two-tier
  (working-history autosave / promoted versions); hybrid auto-detect→promote.
- **Durable store:** CAS immutable blobs + Merkle manifest → S3/MinIO; refs/
  pointers/ledger/op-log/index → Postgres (lakeFS Graveler prior art). Keys sharded
  by high-cardinality prefix for rate-limits + locality.
- **Media:** CAS + multipart + type-gated FastCDC.
- **GC:** mark-and-sweep + grace window from day one; expire dead session branches;
  compact working-history.
- **Search:** Postgres metadata → FTS (drop `_source`) → vector (gated, in-
  traversal filtering); promoted artifacts only.
- **Access:** API-first (carries provenance/freshness/subscribe/ACL — the safety
  spine); read-only grep-mount as a fast-follow convenience.
- **Docs:** artifact merge-class `mergeable-doc`, suggestion-then-approve default,
  event sync (seconds); CRDT live-edit only as an opt-in fast-path that commits
  back to the artifact chain (CRDT-as-cache, store-as-truth).
- **jj:** optional local-only ergonomic engine; not the storage backing.

## Open decisions

- **Reconciliation default** when an artifact forks (two editors from one base):
  lean **conflict-state version** (jj-style, ceremony-free) + **human-sticky** on
  human-touched bytes. Confirm.
- **jj local engine vs. build the CAS-ledger jj-shaped** — spike jj as a local
  per-container engine (auto-snapshot, conflicts, change-IDs) vs. emulate those
  semantics in our own store.
- **Structured data** — confirm deferred / BYO, or scope a minimal versioned-table
  story later (Neon/Dolt).
- Promotion-rule specifics (which scopes auto-promote vs. stage).

## Sources

Forkable/CoW: Morph, E2B (github.com/e2b-dev/infra), Firecracker snapshotting,
CRIU. Data backings: lakeFS Graveler (docs.lakefs.io/understand/how/versioning-
internals), Dolt prolly-trees (dolthub.com/docs/architecture/storage-engine),
Xet/FastCDC (huggingface.co/blog/from-files-to-chunks; USENIX ATC'16), Neon
branching, S3 perf (docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-
performance.html), S3 PUT bench (topicpartition.io). jj: docs.jj-vcs.dev
(architecture, roadmap, git-compatibility), jj-vcs/jj issues #80 (LFS) / #2865
(CDC) / #1841 / #4545 / #6830, LWN 958468.
