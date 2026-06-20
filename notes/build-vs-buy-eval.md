# Build-vs-buy eval — agent workspace sync layers (team/org scale)

> **Status: EVAL COMPLETE (2026-06-20).** The focused build-vs-buy pass that
> `agent-sync-design.md` §5D / §8 called for — analogous to the lakeFS spike, over the
> *commodity sub-layers* of the workspace-sync stack. Method: 5 parallel research passes
> (primary-source-cited) + 2 hand-computes (storage economics, conflict probability) + a
> 10-story user-story stress-test + grounding the reuse claims against the shipped code.
>
> **Scope decisions (Gary, 2026-06-20):** optimize for the **team/org scale
> architecture** (where packing/CDC/multi-tenant actually bite), **self-managed is
> settled** (no substrate-buying analysis — node-scan capture stands), **concurrent
> shared editing is first-class near-term** (inbound-sync + conflict UX is a priority, not
> deferred). Sister docs: `agent-sync-design.md`, `agent-data-architecture.md`,
> `spike-artifact-store.md`, `cas-ledger-build-plan.md`.

## 0. Verdict in one line

**Buy the *algorithm*, borrow the *pattern*, build the *glue*** — and there is **no buy
option for the whole** (the integration is the product; confirmed by the competitive
landscape). Concretely: vendor `fastcdc-rs`/`xet-core` (chunking) + Vector (capture
ship) + Parquet/DuckDB (cold archive); borrow the segment+index and shadow-ref patterns
(each ≈ a script on PG+S3); build the conflict-state ledger (done), the no-ingress
egress-sync orchestration, the overlay-upper node-scan capture, lower-hydration, and the
agent-UX policy. **No core decision reverses.** The eval *adds* four adopt-targets, one
competitor to watch (Mesa), and three measurable un-defer triggers.

## 1. Per-layer scorecard

| Layer | Best OSS prior art | Stance | What we actually adopt / build | Un-defer trigger |
|---|---|---|---|---|
| **Chunking / CDC** (large churny binaries) | restic, borg, Kopia, casync, **fastcdc-rs**, xet-core | **BUY the chunker** | `fastcdc-rs` (Rust, active, v4.0.1 Apr 2026) as the CDC lib | Large-binary (>chunk-size) versioned storage dominates cost — *not* before |
| **Pack-file + index + GC** | git packfiles, restic/Kopia pack format | **BUILD (small)** | xorb-style packs ≤64–128 MB + `chunk_sha→(pack,off,len)` PG index + refcount GC. ~1–1.5k LOC — *same shape/risk as the shipped `artifact-ledger-gc.ts` lease worker* | Ships with CDC (same un-defer) |
| **Large-file streaming (>16 MiB)** | Xet protocol / **xet-core** (Apache-2.0) | **BUY the protocol** | `xet-core` CAS/CDC crates (the layer jj's own roadmap points at) — closes the C3 streaming gap | The >16 MiB requirement lands (Centaur opt 1/2) |
| **Append-only log storage** (transcripts) | Loki, Kafka, ClickHouse, Parquet | **BORROW the pattern** | Keep **PG as resume source-of-truth**; seal cold tails to packed S3 (≤64–128 MB) + sparse `(session,seq)` index — the existing offload-worker shape | PG `bytea` tail exceeds retention/size budget |
| **Capture / ship daemon** | Vector, Fluent Bit | **BUY (adopt)** | **Vector** (MPL-2.0, disk-buffer at-least-once) as the node tailer for transcripts/logs — replaces a hand-rolled tailer | Now (when wiring the log destination) |
| **Working-history cold archive** | Parquet+S3, ClickHouse | **BUY (light) / WATCH** | **Parquet+DuckDB** time-partitioned on S3 (trivial prefix-delete GC); **ClickHouse only at analytics scale** | ClickHouse when cross-corpus analytics walls a single PG primary |
| **POSIX-over-S3 / lazy hydrate** (the `lower`) | JuiceFS, Mountpoint-S3, CubeFS, Alluxio | **BUILD** | Parallel-GET materializer + node-local CAS cache + **reflink/hardlink** (the lower is content-addressed + fully known from the manifest → a FS's two hard problems vanish) | Mountpoint-S3 *read-only* only if pre-materializing ever proves too slow (sparse hydrate) |
| **WIP working-copy snapshot** (code repos) | dura, jj | **BORROW the pattern** | Script `GIT_INDEX_FILE`→`git commit-tree`→push `refs/centaur/wip/*` via the node daemon (steal dura's mtime-peek throttle). dura is **local-only/no-push → disqualified by no-ingress**; jj-for-WIP = op-log/watchman tax for no gain | n/a (build now per §5A) |
| **Versioned CAS + conflict-state over S3** | lakeFS, Nessie, Dolt, **jj** | **BUILD (decided, re-validated)** | Own CAS-ledger (shipped, PR #35). **No OSS jj cloud backend exists in 2026** (Google's is closed) — jj stays the *model*, not the engine | n/a |
| **File sync between hosts** | Syncthing, Mutagen, rclone | **N/A** | No-ingress disqualifies all (need reachability) — this is *why* we build egress sync | n/a |

## 2. Layer detail (the evidence)

### 2a. Chunking / CDC / pack — buy the algorithm, build the glue
- **Buy `fastcdc-rs`.** Active (v4.0.1, Apr 2026), maintained, wraps gear-hashing in a
  normalized chunker. The standalone `gearhash` crate is **unmaintained (~2020)** — do
  not use it raw; only reach for it to reproduce Xet's exact boundaries for interop.
- **Build the pack-index + GC (~1–1.5k LOC).** No OSS cleanly embeds the *full*
  CDC+pack+GC stack against our own `cas/<sha>` keyspace — restic/borg/Kopia force their
  repo format; Xet's *backend* is HF-coupled. The hard part is **GC/compaction
  concurrency with in-flight writes**, *not* the algorithm — and that is the **exact
  shape of the already-shipped `sweepUnreferencedBlobs` + lease worker** (grounded in
  `artifact-ledger-gc.ts`), so it is a known quantity, not the "multi-year trap."
- **CDC is correctly deferred.** Hand-compute: CDC saves **14–34×** on a large file
  edited with small deltas (100 MB × 50 edits @1% → 5 GB whole-object vs ~149 MB CDC) but
  **~1×** for text/code (sha256 whole-object dedup already collapses unchanged files; a
  fully-rewritten file gets no win). So un-defer **only** when large-churny-binary volume
  dominates storage — gate by type, exactly as the data-arch doc says.

### 2b. Append-only logs — borrow the pattern, keep PG as source-of-truth
- **The naive path is catastrophic, the fix is a script.** Hand-compute: one-S3-object-
  per-event = **$1.3k/mo (50 agents) → $13k/mo (org peak)** in PUT requests alone +
  **8–86 M objects/day** (LIST/GC nightmare). Sealing one packed segment per agent per
  minute is **120–300× cheaper** in objects+PUTs. But this is *borrow the Kafka/Loki
  segment+sparse-index pattern* (≈ the existing offload worker), **not** adopt a log
  system.
- **Don't adopt:** Loki (AGPLv3 + per-session label is its own documented cardinality
  anti-pattern + lossy-grep shape), Kafka/Redpanda (retention-bounded transport, not
  queryable, redundant with PG; Redpanda tiering is paid), agent-trace tools
  (Langfuse/Phoenix/Helicone/OTel) — **observability-lossy**: OTel GenAI captures no
  prompt content by default, Langfuse hard-truncates at 4.5 MB → disqualified as a
  *resume* source-of-truth. Use them *alongside* for human debugging, never as the SoT.
- **Do adopt:** **Vector** as the capture/ship daemon (replaces a hand-rolled tailer);
  **Parquet+DuckDB** as the working-history cold archive (partition by `dt=`, GC = delete
  the prefix). Threshold to add **ClickHouse**: only when working-history append + *cross-
  corpus* analytical queries wall a single PG primary — and then as a *second store fed
  from* the PG SoT, never the SoT.
- **Hold firm:** observability store (lossy/sampled/truncated, for humans) ≠ resume SoT
  (complete + byte-faithful, must reconstruct session state). The transcript store stays
  ours end-to-end.

### 2c. POSIX-over-S3 hydrate — build, don't buy
- **The decisive insight:** the artifact `lower` is **content-addressed and fully known
  upfront** (the hydration manifest gives every `path→sha`). That eliminates the two hard
  problems a POSIX-over-S3 FS exists to solve — namespace metadata (we own it) and
  write/mutation semantics (the lower is read-only). What remains = "fetch N immutable
  blobs, lay them out as a tree" → **parallel-GET + node-local CAS cache keyed by sha +
  reflink** (CoW sharing across pods on a node for free; cache is correct-by-construction
  because blobs are immutable — no invalidation, no metadata-sync interval to tune). ~a
  few hundred LOC, **zero new stateful infra**.
- **Don't adopt:** JuiceFS (owns the bucket, *cannot* serve a pre-existing `cas/<sha>`
  keyspace, and **mandates an external metadata DB = a cross-tenant blast surface** —
  directly against VM-per-tenant), CubeFS (full storage system, owns layout, competes
  hardest), SeaweedFS/Alluxio (can *front* the bucket but bolt on a **second metadata
  authority** that drifts from our manifest), s3fs/goofys/rclone (the unfit FUSE that was
  already rejected — non-atomic rename, full re-PUT on partial write, no locking).
- **Back-pocket only:** **Mountpoint-S3 read-only** is the *one* complementary tool
  (stateless, 1:1 keys, GA EKS CSI) — reach for it only if pre-materializing the lower
  ever proves too slow and we want sparse pull-on-open. Even then it shows `cas/<sha>`,
  not a path tree, so it needs a path→sha symlink farm.
- **Grep-mount** (browse the artifact namespace as files) = same logic → build a
  read-only view over the manifest / reuse the serve-by-path route + a thin FUSE shim.

### 2d. WIP snapshot — borrow dura's *idea*, not dura
- **dura** does almost exactly the spec'd thing (shadow-ref auto-commit that never touches
  HEAD/branch/index — the central safety property) and is **not abandoned** (Apache-2.0,
  active to 2026-03). **But its snapshots are local-only with no push** → breaks the
  hard "durable on crash/destroy in a no-ingress box" requirement; you'd wrap it anyway.
- **jj-for-WIP** = elegant auto-snapshot but a colocated `.jj`, op-log GC, watchman dep,
  and a second VCS brain per sandbox — buys nothing the shadow-ref script doesn't, and
  doesn't solve the egress half either.
- **Build the ~50-line `git commit-tree` + `refs/centaur/wip/*` push** (side
  `GIT_INDEX_FILE` → zero index contention; node daemon does the push). It's the *only*
  option that gets WIP off-box. Treat dura as validation the approach is right; steal its
  mtime-peek (`PollGuard`) throttle.

### 2e. Versioned store / jj backend — build decision re-validated, one adjustment
- **No OSS jj cloud/S3 backend exists as of 2026.** jj's `Backend` trait is pluggable but
  the only production OSS backend is `GitBackend` (git objects); Google's database-backed
  cloud server **remains closed-source** (the public roadmap still phrases it as
  aspiration); large-file/CDC is open issue #2865 (no impl). **jj is not buyable as a
  backend** — it stays the conceptual reference, not a substitute.
- Of all engines, only **jj** and **Dolt** persist conflicts as committable *state* (not
  block-or-pick) — and both are unbuyable here: jj has no OSS cloud backend; Dolt is a
  SQL **database server** (wrong shape for file artifacts, no native S3 backing, no
  tenant RBAC). Everyone else (lakeFS, Nessie, DVC, git-annex) is git-style block-or-pick
  — the exact conflict-fit failure that lost lakeFS 39–29.
- **One adjustment to bank (not a reversal):** the single real coverage gap vs. the field
  is large-file streaming. **`xet-core` is now genuinely open (Apache-2.0, published Xet
  protocol spec, reusable `cas_types`/`cas_client` crates)** — adopt it as the chunking
  layer under our CAS when un-deferring large files, rather than inventing one. Same place
  jj's roadmap points.

## 3. The must-build glue — and why there's no "buy the whole" (competitive evidence)

Across 8 agent platforms the pattern is **universal: ephemeral/snapshot compute + git as
the only durable shared substrate.** Devin, OpenAI Codex, Claude Code (web), Cursor,
Copilot all fan out into **isolated VMs and reconcile via branches/PRs**, deferring
conflicts to ordinary git (Claude Code openly admits it can't auto-handle merge
conflicts). None ships a shared, durable, versioned *artifact* store with conflict-state.

- **No buy for the whole.** The one genuinely same-shaped product is **Mesa (mesa.dev)** —
  "versioned filesystem for agents," fork-and-run-dozens, fleet repos, Changes/Bookmarks.
  It validates the *category* but is closed/private-beta, **has not disclosed its conflict
  semantics or CAS internals**, and buying it = coupling to a direct competitor. **Atrium's
  published edge is exactly Mesa's undisclosed parts:** jj-style per-file conflict-state
  (not whole-object), CAS-on-our-own-S3, node-daemon outbound capture, no-ingress.
- **Substrate is a *partial* buy — and it only buys compute + snapshot + a flat volume.**
  Modal and Daytona shared volumes are **explicit last-writer-wins** ("data the last
  writer didn't have will be lost"; "FUSE-backed, not transactional"). Morph's "infinite
  branching" is **unidirectional VM fork with no merge/reconcile/conflict-state**. E2B
  Volumes / Modal Volume-v2 are beta with thin concurrent-write guarantees. → the
  versioned-store + conflict-state + sync layer is **unbuyable**; confirms the thesis and
  Gary's "stay self-managed, period." (No-ingress aside: Coder/Namespace fit egress-only
  best; Morph/Daytona/Gitpod assume inbound HTTP/SSH — but the node-scan capture sidesteps
  all of them regardless.)

**The must-build list (no single product fits):** the conflict-state CAS-ledger (done),
the **no-ingress egress-only sync orchestration**, the **overlay-upper node-scan
capture**, **lower-hydration** (§2c), **inbound fetch+stage+adopt** (the part Gary made
first-class), the **agent-UX policy** (structural scoping, merge-class, filtering,
workspace-scoped identity), and the **per-tenant VM model**.

## 4. Hand-compute evidence (the thresholds that gate the un-defer triggers)

- **Transcript object explosion** (justifies the seal/pack pattern, dates the trigger):
  naive 1-obj/event = $1.3k–13k/mo PUTs + 8–86 M objects/day; packed = 120–300× less. We
  already avoid the naive path via the PG hot-tier → packing is a *seal-script* trigger
  (PG tail > budget), not a chunker buy.
- **CDC payoff is type-gated:** 14–34× on large churny binaries, ~1× on text. → CDC
  un-defer = large-binary storage cost dominates, nothing sooner.
- **CAS prefix sharding is free:** `cas/<sha>` spreads writes across 256+ hex prefixes, so
  the S3 ~3,500 PUT/s/prefix wall is a non-issue (it only bites flat per-session keys).
  Even 1,000 agents × 3 captures/s = 3,000 PUT/s fits comfortably once sha-sharded.
- **Conflicts are load-bearing, not rare:** on a hot 50-artifact shared pool with 50
  agents, ~**60%** of writes collide with another in-flight edit (tens–thousands/hour
  depending on pool size). A silent lost-update is unbounded cost; the conflict-state
  machinery is bounded → **justified**, exactly the concurrent-edit workflow Gary flagged
  first-class. The quieter danger is **stale reads** (acted on a superseded version, no
  signal) → justifies **live inbound-sync (C1)**, freshness-in-seconds not at-promote.

## 5. User-story stress-test (team/org scale) — and the gaps it surfaces

10 stories run against the design; full table in chat. Holds for: concurrent edit (base-
aware capture → conflict-state), tiny-log explosion (PG+seal), `node_modules` (structural
scoping), delete-vs-edit detection, human-in-app append vs edit, browse-all (serve+grep-
mount). **Three genuine gaps to carry into the build list (none fatal):**
1. **Autonomous stale-read reconcile trigger** — surfacing the `/incoming` marker as a
   steer so an autonomous agent rebases at a safe checkpoint (spec, not built).
2. **Delete-vs-edit resolution UX** — stay-deleted vs resurrect is an open product call.
3. **Lower-stability across pause/resume** — the re-provisioned lower must be byte-
   identical to the persisted upper's base (the manifest pins base versions → tractable,
   but unverified on a real node).

**Competitor user-story gaps worth considering (we have the primitives, not the UX):**
(a) **instant whole-environment fork** (Devin `blockdiff` / Replit Bottomless / Morph,
~200 ms) — a "branch this whole session to explore an alternative" power-UX, layerable on
the CAS ledger; (b) **run-N-parallel-agents-then-pick-best** as a first-class loop
(Replit/Cursor/Mesa) — we have workspace-scoped versions + conflict-state, but the
compare-branches/pick-winner UX is unconfirmed; (c) **rich per-run demo artifacts**
(screenshots/video as merge-ready evidence).

## 6. Recommendation / next concrete steps

1. **No core reversal — proceed with the build** (`agent-sync-design.md` + Track C4).
2. **Bank the four adopt-targets** so we don't hand-roll them: `fastcdc-rs` (chunker),
   `xet-core` (large-file CDC, when >16 MiB lands), **Vector** (capture/ship daemon now),
   **Parquet+DuckDB** (working-history cold archive). Add `@aws-sdk/lib-storage` for
   multipart (confirmed *not* in deps today — net-new, matches the spike estimate).
3. **Build the pack-index + GC by cloning the shipped `artifact-ledger-gc.ts` shape** when
   un-deferring CDC — it is the same lease/grace/sweep concurrency problem, already solved
   once.
4. **Prioritize inbound-sync (C1) + conflict UX this round** (Gary: first-class) — it's
   the hand-compute-justified gap (stale reads + hot-pool collisions), and the user-story
   gaps #1/#2 above live here.
5. **Watch Mesa** as the one same-category competitor; **re-test E2B/Modal volume
   concurrent-write guarantees** only if a substrate bet is ever reconsidered (it isn't,
   per Gary).

## 7. Sources (primary, from the 5 research passes)
- Chunking: [fastcdc-rs](https://github.com/nlfiedler/fastcdc-rs), [xet-core](https://github.com/huggingface/xet-core) + [Xet protocol](https://huggingface.co/docs/xet/index), restic/borg/Kopia/casync docs.
- Logs: AWS S3 request-rate docs (3,500 PUT/5,500 GET per partitioned prefix), Loki cardinality docs (AGPLv3), [Vector](https://vector.dev), Kafka segment defaults, ClickHouse async-insert/SharedMergeTree docs, Langfuse 4.5 MB truncation / OTel GenAI no-content-by-default.
- POSIX-FS: Mountpoint-S3 `SEMANTICS.md`, JuiceFS POSIX+architecture docs (external metadata engine), CubeFS (CNCF Graduated Jan 2025), Alluxio OSS docs, s3fs/goofys "Filey System" caveats.
- jj/WIP/versioned: [jj repo](https://github.com/jj-vcs/jj) + [roadmap](https://docs.jj-vcs.dev/latest/roadmap/) + issues #80/#2865, [dura](https://github.com/tkellogg/dura), [Dolt conflicts](https://docs.dolthub.com/concepts/dolt/git/conflicts), Nessie, DVC, git-annex.
- Competitive: Cognition [blockdiff](https://cognition.com/blog/blockdiff), [OpenAI Codex cloud](https://developers.openai.com/codex/cloud/environments), [Claude Code web](https://code.claude.com/docs/en/claude-code-on-the-web), [Cursor background agents](https://cursor.com/docs/background-agent), Replit [snapshot-engine](https://replit.com/blog/inside-replits-snapshot-engine), [E2B persistence](https://e2b.dev/docs/sandbox/persistence), [Modal volumes](https://modal.com/docs/guide/volumes), [Morph branch](https://cloud.morph.so/docs/documentation/instances/branch), [Daytona volumes](https://www.daytona.io/docs/en/volumes), [Coder networking](https://coder.com/docs/admin/networking), [Mesa](https://mesa.dev/blog/introducing-mesa-filesystem-for-agents).
