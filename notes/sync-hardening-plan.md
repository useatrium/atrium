# Agent sync — hardening & completion plan (the holes, sequenced)

> **Status: PLAN (2026-06-21).** The honest gap-review after the first build
> (`sync-implementation-plan.md` shipped the spine + CRITICALs; this closes the
> holes). Scope decided with Gary: **everything** incl. multi-tenant (#19) + the
> LSN feed (#7-prod) + Linux CI. Repo UX decided: **read-only preview + steer-to-
> change** (node-live bytes, forge fallback; NO in-app repo commit — POC-confirmed
> that direct repo-edit races the agent + corrupts live git ops, and §10.7 keeps
> repos out of the artifact-sync system entirely). Execute max-parallel via agent-
> fanout (Atrium SQL/TS lanes → codex worktrees; Centaur Rust + kind/k8s + cross-
> repo seams → Claude direct).

## The holes (honest §8B tally)
GENUINELY CLOSED in round 1: #1 (openat2 escape, POC), #2 (echo/base — *logic*; not
yet wired stateful), #3 (torn-read + inverse-write, POC), #5 (conflict reads), #7
(xmin outbox), #10 (manifest/cache — *code*, not scaled), #18 (reflink — *code*, never
on CoW fs). EVERYTHING ELSE was specified-not-built. This plan builds the rest.

| ID | Hole | §8B | Lane |
|----|------|-----|------|
| **F1** | Daemon state: persist manifest/sync-state/cursor (the spine) | #2 | Centaur |
| **F2** | `blob_refs` normalization (trigger extracts conflict-side shas) | #8 | Atrium |
| **F3** | `pending_blob` row + write path | #9 | Atrium |
| **H1** | base-aware capture + advance-base-after-adopt + startup lower-materialize | #2/#10 | Centaur |
| **H2** | two-daemon conflict e2e (the headline proof) | — | Centaur |
| **H3** | GC marks from `blob_refs` + honors conflicts/leases/outbox-lag | #8 | Atrium |
| **H4** | verify-HEAD-then-advance-latest + orphan-sweeper | #9 | Atrium |
| **H5** | `/atrium` projection (current.md + events.jsonl) + sibling transcripts + **ACL hybrid** | #4/#6 | split |
| **H6** | WIP patch-artifact wired into the daemon heartbeat (pure-read) | §5A | Centaur |
| **H7** | wire `VersionSkewBadge` into the Files/artifact view | #14 | Atrium |
| **H8** | large-file streaming multipart (node→S3 direct) + route large/append-heavy OUT of overlay ns | #20/#12 | Centaur |
| **H9** | backpressure: per-session dirty-byte budget + scan-lag metric + pause-before-ENOSPC | #11 | Centaur |
| **H10** | atomic multi-file commit-group / tree-manifest snapshot | #13 | split |
| **H11** | validate the real `redirect_dir=on` rename xattr on a node (not just the fallback) | #16 | Centaur |
| **H5b** | Files repo half = **read-only** (node-live + forge fallback); **drop `commitFile`** | §2 | split |
| **R1** | LSN logical-replication-slot change-feed (xmin outbox as fallback) | #7 | Atrium |
| **R2** | VM-per-tenant: per-tenant node→DaemonSet, microVM manifests | #19 | Centaur |
| **R3** | build node-sync image, load into kind, run as the **DaemonSet pod**, e2e pod-native | — | Centaur |
| **CI** | Linux CI job: openat2/FICLONE/`/proc` validations + distributed e2e (+ pod-native) | — | Centaur |

## Repo model (baked in — the H5b/§5A decisions)
Repos are **agent-owned + forge-synced, NOT in the artifact-sync system** (§10.7).
- Provision: repo = `clone --shared` RO-lower; agent edits→upper, commits→upper
  (private CoW — POC-confirmed the lower stays pristine), push→forge.
- Multi-agent: separate overlays/branches, reconcile via forge PRs (git's job).
- Files surface repo half: **read-only preview + `git log` history**, bytes from the
  **node** (live working state incl. uncommitted) with **forge fallback** for stopped
  sessions. **No in-app commit** (ST1: races the agent, corrupts mid-rebase, no ledger
  to mediate). Humans change code by **steering the agent**.
- Durability: node pure-read `git diff HEAD` + untracked → ledger blob (H6); zero git writes.

## Waves (dependency-ordered; ∥ = parallel)

**Wave 0 — foundations (3 ∥):** F1 *(me)*, F2 *(codex)*, F3 *(codex)*.
**Wave 1 — build on F (∥):** H1←F1 *(me)*, H3←F2 *(codex)*, H4←F3 *(codex)*,
  H7 *(codex)*, H11 *(me)*, R1 *(codex)*.
**Wave 2 — spine closes + subsystems (∥):** H2←H1 *(me)*, H6←F1 *(me)*,
  H5 *(codex endpoint ∥ me node-tree)*, H8 *(me)*, H10 *(codex ledger ∥ me hydrate)*,
  H5b *(codex web read-only ∥ me node repo-read API)*.
**Wave 3 — scale + prod (∥):** H9←H1 *(me)*, R2 *(me, k8s)*, R3 *(me)*.
**Cross-cutting:** CI grows each wave; **merge each lane to master/integration as it
greens** (the standing instruction).

## Gates / definition of done
- Headline: a **two-daemon** run produces a real conflict, a human resolves it, both
  agents converge — green in CI.
- Correctness: GC never deletes a conflict-side blob; no readable orphan after an
  upload crash — both with regression tests.
- Every CRITICAL/MAJOR/MOD §8B issue closed by code **+ a test** (not just a doc cell).
- Linux CI exercises the real syscalls + the distributed + pod-native e2e.
