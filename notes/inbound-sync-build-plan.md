# Inbound sync (C1) + conflict UX — build plan

> **Status: BUILD PLAN (2026-06-20).** The actionable plan for the near-term first-class
> priority Gary set: **live mid-session inbound sync + concurrent-edit conflict UX**
> (a running agent sees a teammate's edit within seconds; conflicts never silently lose a
> side; humans get a clear resolution surface). Design lives in `agent-sync-design.md`
> §4–6 (this is the lanes/sequencing). Supersedes the in-container model in
> `inbound-sync-spec.md`. Justified by the hand-compute (hot-pool collisions + stale
> reads are load-bearing at team scale — `build-vs-buy-eval.md` §4).

## 0. The pleasant surprise — the Atrium conflict core is already shipped

Grounding against the code (not assumed): **most of the durable-side conflict machinery
landed with PR #35.**

| Capability | Status | Where |
|---|---|---|
| Write-back PUT + OCC (`base_seq` required) | **BUILT** | `artifact-writeback.ts` `writeBackArtifact` |
| node-diff3 3-way merge, merge-class-gated | **BUILT** | `artifact-writeback.ts` (`mergeDiff3`, `merge_class==='mergeable-doc'`) |
| First-class `status=conflict` version (both-sides payload) | **BUILT** | mig `033` (`status`/`conflict`/`base_seq` cols) + writeback |
| Movable pointers (`latest`) | **BUILT** | mig `033` `artifact_pointers` |
| Advance signal | **BUILT (in-process)** | `artifact-ledger.ts` → `pg_notify('artifact_advanced', …)` |

⇒ C1 is **not** "build the conflict engine." It's: (a) a *small* Atrium change-feed the
node can **egress-poll** + the conflict-resolution **UX surface**, and (b) the **Centaur
node-side** fetch/stage/adopt + the **hydration manifest** (the genuinely new, bulk work).

## 1. The two halves

| Half | Repo | Bulk of work | Gating |
|---|---|---|---|
| **Atrium-side** | this repo (TS/SQL) | small — change-feed endpoint + conflict UX + scope query | none — buildable now on the shipped ledger |
| **Centaur-side** | `services/api-rs` (Rust) + runtime | large — manifest, node-side merge (write-through-`merged`), `/atrium` projection, quiesce signal | gated on Track C4 overlay + node-scan landing |

## 2. Atrium-side lanes (buildable now)

- **A1 — node-pollable change-feed.** `pg_notify` exists but only an in-process `LISTEN`
  hears it; the node daemon needs a durable, resumable, egress-pollable feed. Build a
  `GET /sessions/:id/artifacts/changes?since=<seq>` (and/or a thin `artifact_changes`
  outbox the trigger appends) returning `{path, seq, base_seq, sha, status}` rows since a
  watermark. Small (the eval called this "trivial on Postgres"). *Keep the `pg_notify`*
  for the in-app WebSocket hub (live UI) — the poll-feed is for the no-ingress node.
- **A2 — write-back + conflict-state.** ✅ **DONE** (PR #35). Only follow-ups:
  resolution = a write-back **against the conflict seq** (verify the path), and confirm
  the merge-class gate (binary→immutable, JSON/YAML/CSV/ipynb→whole-file conflict-state,
  code/md→diff3) matches §10.6.
- **A3 — conflict-resolution surface (UX).** The one real new Atrium UI: in the
  **Work/Changes drawer** (Phase 4), render a `status=conflict` version as a both-sides
  diff (the `conflict` jsonb carries each side's label/author/sha + markers); "resolve"
  writes back a chosen/merged blob against the conflict seq → `latest` advances to a
  normal version. Banner for humans; for agents the marker is surfaced as a steer (§4).
- **A4 — hydration scope query.** "Which paths did this session hydrate" = the feed the
  node subscribes (workspace/topic-scoped per §10.1). Atrium exposes the scope→paths
  resolution; the manifest itself is produced Centaur-side (C-hydrate).

## 3. Centaur-side lanes (gated on Track C4; the bulk of the new work)

- **C-hydrate — hydration manifest** (`path → base_seq`, written at startup; also
  materializes the artifact `lower` per `build-vs-buy-eval.md` §2c: parallel-GET +
  node-local CAS cache + reflink). **The linchpin** — both base-aware capture *and*
  adopt-time diff3 need it.
- **C-capture-base — base-aware capture.** The node-scan must pass the hydrated `base_seq`
  per path so concurrent shared edits route through OCC/diff3 (A2) instead of
  blind-append. Without this, conflicts aren't detected (hand-compute #1/#5).
- **C-merge — node-side fetch + merge + write** (REVISED 2026-06-20: node-side, not an
  in-container adopter — see `agent-sync-design.md` §4). Node polls A1's feed for hydrated
  paths; fetches `theirs`; runs the 3 cases itself (unedited → write; edited → `diff3(base,
  ours, theirs)` clean→write / conflict→markers + ledger `status=conflict`; resurrect →
  write); **writes through the shared `merged` mount** (reachable host-side via `rshared`).
  `ours` = the `upper` the node already reads for capture.
- **C-quiesce — harness "between-steps" signal** (+ node `/proc/<pid>/fd` gate) so a write
  never lands mid-read. *This is the only in-container residue* — invisible to the model.
  **Replaces** the old `/incoming` marker + in-container adopter (demoted to node-internal).
- **C-project — `/atrium` context projection** (§2A): node maintains the read-only context
  tree (chat + sibling transcripts + artifacts view) as **append-tail** (no merge/quiesce),
  one shared copy per node, reflinked into pods. Steers ride the normal message stream.
- **C-verify — pre-build POC gate** (expanded by the 2026-06-20 adversarial review,
  `agent-sync-design.md` §8A). On the kind/centaur-image harness, prove all five before
  C-merge: (a) **inverse write** node-writes-`merged` → agent-reads; (b) **symlink-escape
  blocked** — agent symlink under `upper`, scanner with `openat2(RESOLVE_BENEATH|
  NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV)` refuses to follow it; (c) **no echo loop** —
  node-injected write is NOT re-captured (per-path-state / base-advance suppresses it);
  (d) **ownership** — root-written file chown'd so the uid-1001 agent reads+overwrites it;
  (e) **write race** — atomic temp+rename + per-path lease holds under a concurrent agent
  write. **Gate C-merge on all five.**

## 4. Sequencing

```
A1 (change-feed) ──┬── unblocks C-fetch
A2 (✅ done)        │
A3 (conflict UX) ──┘   depends on A2 (done) → buildable now, parallel to A1
A4 (scope query) ──── pairs with C-hydrate

Centaur: C-verify → C-hydrate (linchpin) → C-capture-base + C-merge → C-quiesce
         C-project (independent, append-tail) ── all gated on Track C4 landing
```
**Land first (Atrium, no Centaur dependency):** A1 + A3 — they give the live-UI conflict
loop for *human + in-app* edits immediately, even before the sandbox node-side exists.
**Then** the Centaur lanes light up cross-*agent* live sync.

## 5. Open product calls (resolve before/within the build — the 3 gaps)

1. **Autonomous stale-read reconcile trigger** — the node lands the merged file (case 1/2);
   *how* does an autonomous agent notice + re-ground? (inject a steer message; it re-reads at
   its next step, never mid-write). **Decide the trigger contract** (the node-side merge means
   the file is already fresh; the open question is the *notification*, not the merge).
2. **Delete-vs-edit resolution default** — stay-deleted vs resurrect (adopt case 3). A
   product call; pick a default + an override.
3. **Lower-stability across pause/resume** — the re-provisioned `lower` must be
   byte-identical to the persisted `upper`'s base; the manifest pins base versions →
   tractable, **verify on a real Linux node** (Track C4 commitment #3).

## 6. Conflict-UX principles (the through-line)

- **jj-style, never blocks:** `latest` always advances; a collision becomes a committable
  `conflict` version, resolved later as a normal edit. (Already how A2 behaves.)
- **Human:** banner + both-sides diff in the Work/Changes drawer; resolve = one edit.
- **Agent:** marker surfaced as a steer; auto-rebase via diff3 at a checkpoint; on
  unresolved conflict, **record + flag, don't loop**.
- **WIP code** (separate from artifacts): captured as a **pure-read patch-artifact, no git
  refs** (§5A decision) — out of C1's artifact-sync path, but shares the node daemon.

## 7. Fan-out

- **Atrium (now):** codex fan-out for A1 + A3 (+ A4) per `codex-delegation-pattern`;
  Claude orchestrates (plan, review diffs firsthand on the cross-branch seams per
  `self-review-before-codex`, QA, merge). A2 is done — just verify-and-test.
- **Centaur (gated):** separate Rust effort in `services/api-rs` + runtime, sequenced
  after Track C4; not a codex-in-this-repo fan-out.

## 8. Relationship to other docs
- `agent-sync-design.md` §4–6 — the design this plans.
- `cas-ledger-build-plan.md` Track C4 — the overlay + node-scan this is gated on; §10 decisions.
- `build-vs-buy-eval.md` §4 — the hand-compute that justifies prioritizing this.
- `inbound-sync-spec.md` — **superseded** (in-container daemon → node-side fetch/stage).
