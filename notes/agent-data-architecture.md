# Agent Data Architecture — logs, artifacts, workspaces

Status: **DRAFT / in progress** (started 2026-06-19). Conclusions are preliminary
and still under discussion.

This is the data/storage-layer deep-dive. It captures the research, the explored
ideas, the discussion + Gary's feedback, the current implementation state, and
working conclusions. Sister docs:
- `agent-session-resume-and-storage-plan.md` — resume/sleep/harness strategy
  (created 2026-06-16). Resume mechanics live there.
- `harness-resume-workstream.md` — the harness-resume execution checklist + the
  Codex/Claude resume POC results.
- `artifacts-followups.md` — the artifact-capture build status (A1/A2/B1).
- `data-lifecycle.md` — events/files/drafts retention.

## Scope

How three different kinds of agent-session data should be stored, versioned, and
made accessible:
1. **Conversation/agent logs** — harness rollout transcripts + the Centaur event
   stream.
2. **Artifacts** — files produced/edited during a session (md, code, images,
   data), **evolving and edited by both humans and agents**.
3. **Code / dev workspaces** — the repo checkout the agent works in, inside
   Centaur containers.

Plus chat logs (already in Postgres) and the question of giving agents ergonomic
filesystem access to the whole corpus.

**Out of scope / deprioritized:** instantly-forkable sessions. We researched the
forkable-container class (Morph, E2B, Firecracker, CRIU) — it's a useful
reference, not a near-term requirement (Gary, 2026-06-19). Captured below for
record.

## Requirements (Gary, 2026-06-19)

- **Artifacts evolve and are edited by both humans and agents.** Not capture-only;
  a human in the UI or an agent in a later turn must be able to edit an artifact,
  and that becomes a new version. (This is the headline new requirement.)
- **Agent logs and chat logs are appended to.** Chat logs are in Postgres already;
  "might chat logs be modified?" — they are, but via append-only tombstone events
  (edit/delete), original retained. Append-only is the right model.
- **Code/dev workspaces live in Centaur containers.** Keep warm clones ready for
  fast startup.
- **Agents want easy filesystem affordances** to reach artifacts, chat history,
  and even other agents' logs (cf. how Claude Code stores grep-able session
  transcripts under `~/.claude/projects/<project>/<id>.jsonl`).

## The core data model

Three data shapes, three access patterns, three right answers — do **not** chase a
single unifier.

| Shape | Access pattern | Mutation | Right backing | Cheap-fork primitive |
| --- | --- | --- | --- | --- |
| Conversation/agent log | append, sequential replay | none (append-only) | Postgres `session_events` (+ cold rollout-JSONL blobs in S3) | DB branch (Neon-style) or copy the small JSONL |
| Artifacts | random read; **edited** by humans+agents | **mutable, versioned** | S3 + content-addressed blobs + Postgres pointer/version ledger | copy the pointer set (blobs shared by hash) |
| Workspace FS | constant POSIX read/write | mutable | CoW filesystem / warm clone in the container | CoW clone of the layer (overlayfs/ZFS) |

### Append-only vs "I edited an .md" — the resolution

These are not in conflict once you separate **blobs** from **references**:
- The **blob layer is immutable + content-addressed** (each save = a new sha256
  blob, old retained). "Append-only" at the byte layer.
- **Mutation lives in a pointer/ref** (`logical_path → current_blob + history`).
  Editing the .md = hash new content → new blob → advance the pointer → old
  version preserved.

This is exactly Git's object model: immutable content-addressed objects (blob /
tree) + mutable refs. The right *data structure* is a content-addressed Merkle
DAG; **S3 is just the blob backing under it**. "Better than S3?" conflates
structure with backing — keep S3 as backing, put the CAS/version structure on top
(cheap to build in Postgres).

## Current implementation state (audited 2026-06-19)

### Logs
- **Centaur frames → Atrium `session_events`** (migration `027`): append-only
  mirror, `PRIMARY KEY (session_id, centaur_event_id)`. This is the product
  record / replay source. ✅
- **Harness rollout JSONL** (Codex `$CODEX_HOME/sessions/.../rollout-*.jsonl`,
  Claude `projects/.../<id>.jsonl`): **NOT captured anywhere — ephemeral sandbox
  FS, lost on teardown.** ❌ This is the substrate harness-resume needs (proven by
  the resume POCs). The frame mirror is *not* a byte-equivalent substitute.
- **Chat logs** (`events` table): append-only; `message.edited` / `message.deleted`
  are new tombstone events folded on read, original `message.posted` never
  mutated. ✅ Correct model already.

### Artifacts — a flat content-hashed capture log, not yet a Merkle/versioned store
Pipeline (live, end-to-end verified locally; producer still unmerged):
```
sandbox file → Centaur artifact_capture.py worker (sha256 verify, size cap)
  → api-rs POST /agent/executions/{id}/artifacts → artifact_blobs staging
  → emits artifact.captured frame (incl. execution_id)
  → Atrium mirrors into session_artifacts
  → offload worker (claim-lease) fetches bytes from Centaur → uploads to S3/MinIO
  → serve route GET /api/sessions/:id/artifacts/:artifactId
       (302 presigned if offloaded, else proxy from Centaur)
```
- S3 key = `artifacts/{session_id}/{artifact_id}`; `artifact_id` = **16-char
  sha256 prefix**.
- Atrium side (`session_artifacts` mig `031` + `032` lease, `artifact-offload.ts`,
  serve route) is **merged on master**. Centaur producer (`artifact_blobs` mig
  `1000`, capture routes) is **unmerged — integration worktree only.**

What's MISSING vs the "evolving artifacts" requirement:
- **No write-back / edit path.** Capture-only; zero PUT/POST. A human or agent
  cannot edit an artifact and have it stored as a new version. ❌ (biggest gap)
- **No mutable path→version pointer + version chain.** Editing a file just yields
  another content-hashed row; no "current version of path X," no `version`
  column. ❌
- **No global CAS dedup.** Keys are session-scoped → identical content in two
  sessions is stored twice. (Centaur staging dedups only within one execution.) ❌
- **No tree/branch objects, no blob GC/ref-counting** (cascade-deletes only). ❌

So the current store is the **foundation layer** (hashed blobs in S3 + a capture
ledger). To become the Merkle/versioned store the design calls for, it needs the
**pointer/version layer** and the **bidirectional write path** on top.

## Research findings

### A. Forkable / CoW sandbox runtimes (reference class; deprioritized)

Dividing line: forking a *running* sandbox = capturing memory+process state (hard);
most vendors only do disk CoW or single-sandbox pause/resume.

| Platform | Forks running state (mem+disk)? | Mechanism | Latency | Note |
| --- | --- | --- | --- | --- |
| Morph / Infinibranch | yes (`branch(count=N)`) | full-VM snapshot + CoW (closed) | <250 ms | managed leader, opaque internals, tiny vendor |
| E2B | yes | Firecracker + UFFD lazy paging + 4 KiB page dedup | unpublished | **OSS self-host blueprint**; = microVM runtime swap |
| Firecracker (raw) | yes | snapshot/restore + UFFD CoW fan-out | restore <8 ms | primitive under E2B / Lambda SnapStart |
| CRIU | yes (process tree) | checkpoint/restore, no hypervisor | ~2–5× faster than cold | only path that stays k8s/container-native; weaker isolation, GPU/socket caveats |
| Daytona / Fly / Modal / Cloudflare | disk-only / building-blocks / restore-to-fresh / storage-side | — | — | not true live fork |
| Disk CoW: overlayfs / ZFS clone / Btrfs / XFS reflink / dm-thin | n/a (disk only) | CoW FS | ZFS clone <1 s | what we have today via containerd+overlayfs |

**Key takeaway (ties to our POC):** because harness resume is **file-based** (the
transcript JSONL), we do NOT need memory-snapshot forking for *correctness*. A
session fork = copy the JSONL + CoW-clone the workspace + `--resume`. Memory
snapshots (Morph/Firecracker) only buy *cold-start latency* — a v2 perf upgrade,
not a prerequisite. Our containerd+overlayfs stack gives disk CoW but zero
memory/process fork; gaining the latter is a runtime swap (Firecracker) or CRIU.

### B. Data backings for logs + artifacts

The grading axis: **metadata/pointer CoW** (cheap branching — nearly everyone)
vs **data-blob dedup** (cheap large-file editing — almost no one).

| Option | Edit model | Large files | Zero-copy branch | Verdict for us |
| --- | --- | --- | --- | --- |
| **S3 + CAS(sha256) + Postgres ledger** | new blob + repoint | 5 TB obj cap; multipart >100 MB | yes (copy pointer set) | **baseline + recommended**; reuses Postgres we run |
| **lakeFS** (git-over-S3) | **full new object per edit — NO data dedup** | presigned to bucket | yes (true zero-copy) | great git UX, but storage amplifies on churn + self-run GC → not primary |
| **Hugging Face Xet** (FastCDC) | **chunk-level dedup** (~64 KB) | excellent | n/a | only thing that makes editing big files cheap; no turnkey self-host (HF dep) |
| **Dolt** (git-for-data) | row/cell versioning | not for files | yes | for rows, not md/binaries — wrong tool for artifacts |
| **git / git-LFS** | whole-version copies | hard ceilings (100 MB / LFS 2–5 GB) | branch yes | skip for artifacts (the "git + large files" pain) |
| **Neon** (Postgres CoW branching) | n/a (DB) | n/a | **yes, instant, pay-for-divergence** | best cheap-fork for the *log* if logs are in Postgres |
| **JuiceFS** (POSIX over S3) | in-place (real POSIX) | chunked objects | `clone` = metadata-only CoW | best agent-grep mount; wants to own data+metadata layout (see below) |
| **Iceberg / Delta** (table formats) | append + time-travel | Parquet on S3 | branches/tags / shallow clone | analytics-scale logs only; premature now |
| **Diskless Kafka / tiered storage** | append | S3 segments | n/a | overkill until multi-consumer replay forces it |

### JuiceFS — the agent-filesystem-access question (Gary asked to go deeper)

Real POSIX FS: **data → object store, metadata → engine (Redis/Postgres/TiKV).**
Unlike s3fs/Mountpoint (sequential-write-only, no rename), it supports random
writes, rename, locking, close-to-open consistency — agents `cat`/`grep`/`python`
and edit in place. `juicefs clone` is metadata-only redirect-on-write → instant
zero-copy subtree clone (FS analog of a Neon branch).

The catch: **JuiceFS wants to own the data+metadata layout** — its chunking +
metadata engine is a different representation from our sha256-CAS + ledger. Can't
have both canonical over the same bytes. Options:
- (a) JuiceFS *is* the artifact store (its metadata engine = the ledger) — POSIX +
  clone for free, but inherit its layout, lose custom CAS/version semantics.
- (b) S3-CAS canonical; JuiceFS a **read-mostly projection** for agent grep; writes
  go through the capture/version pipeline. Two systems + periodic sync.
- (c) Skip JuiceFS; thin FUSE/CLI over our CAS API (`path→current-version`; reads
  pull blobs, writes POST new versions). Most custom, one source of truth.
Two realities: it needs a **metadata engine we run + monitor**; and **chat
history/logs are in Postgres, not files**, so "grep the logs as files" needs a job
that *materializes* transcripts as files under the mount (regardless of FS choice).

**Lean:** don't make JuiceFS canonical (option b or c). Keep S3-CAS + Postgres the
source of truth; add a read-mostly mount only when agents actually need corpus-wide
grep. Off the critical path.

## Discussion & decisions (running log)

- **2026-06-19 (Gary):** Don't need forkable sessions per se — useful reference
  class only. Real needs = evolving/edited artifacts, append-only logs, warm
  workspaces. → fork research captured but deprioritized.
- **2026-06-19:** "New container resume" = the **same machinery as starting a
  fresh container** (fresh-container resume: restore harness home + inject thread
  id / `--resume`). Sleep just decides reattach-same-sandbox vs rebuild. Warm
  clones = existing warm pool + base-image repo warming. → no separate mechanism.
- **2026-06-19:** Chat logs already append-only w/ tombstones in Postgres — correct
  as-is.
- **2026-06-19:** Artifact store is foundation-only (capture log), not yet a
  versioned/Merkle store; the edit/write-back path is the key gap.

## Open decisions / questions

- **Artifact version model:** add a mutable `path → current_version` pointer +
  version chain (or full Merkle tree)? Where does the pointer live (extend
  `session_artifacts`, or a new table)?
- **Write-back path:** how does a human (UI) or agent (next turn) edit an artifact?
  New PUT endpoint → new blob → advance pointer; and how does the edit reach the
  live sandbox workspace (push file in / next-turn sync)?
- **Human+agent concurrent edits** of the same artifact — last-writer-wins,
  optimistic version check, or collaborative-merge? (Smells like the chat
  edit-event model could extend here.)
- **Global CAS vs session-scoped keys:** move to content-only keys for dedup, or
  keep session scoping for simpler access control / GC?
- **Rollout-JSONL capture:** capture as a `rollout.segment` blob in the same S3
  bucket (append-only namespace) — reuse the artifact byte channel, or a separate
  path? (Unblocks harness-resume.)
- **Agent FS access:** JuiceFS projection vs custom FUSE vs API-only; and the
  "materialize Postgres logs as files" job.
- **Where does this work get tracked** relative to `agent-session-resume-and-
  storage-plan.md` — keep storage here, resume there.

## Working conclusions (preliminary)

1. **Keep the layered split** — logs in Postgres (`session_events`), artifacts in
   S3-CAS + Postgres ledger, workspace in the container. Don't unify via lakeFS.
2. **Evolve the artifact store from capture-log → versioned store:** add the
   path→version pointer + a bidirectional write path. This is the main new build.
3. **Capture the rollout JSONL** (reuse the artifact byte channel) to unblock
   harness-resume; it's small.
4. **Defer:** Xet/CDC (only for big churny files), JuiceFS mount (only for
   corpus-wide agent grep), Neon (only for DB-level session branching),
   Firecracker/Morph (only when warm-fork latency is the bottleneck).

## Sources

Forkable/CoW: Morph (cloud.morph.so/docs/.../branch, morph.so/blog/infinibranch),
E2B (e2b.dev/docs/sandbox/snapshots, github.com/e2b-dev/infra), Modal
(modal.com/blog/mem-snapshots), Fly (fly.io/docs/reference/suspend-resume),
Firecracker snapshotting + UFFD (github.com/firecracker-microvm/firecracker docs;
NSDI'20 arxiv 2005.12821), CRIU (criu.org).
Data backings: S3 versioning/limits (docs.aws.amazon.com/AmazonS3), lakeFS
(docs.lakefs.io/understand/how/versioning-internals, /understand/model),
Dolt (dolthub.com/docs/architecture/storage-engine), Xet
(huggingface.co/docs/hub/en/xet/deduplication, /blog/migrating-the-hub-to-xet;
FastCDC USENIX ATC'16), git-LFS (docs.github.com/.../about-git-large-file-storage),
Neon branching (neon.com/docs/introduction/branching), JuiceFS
(juicefs.com/docs/community/guide/clone), Iceberg/Delta branching
(apache.github.io/iceberg/docs/latest/branching, docs.databricks.com/.../clone).
