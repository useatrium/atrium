# Flat-`~` agent workspace + complete the poll→daemon cutover — design note

> **Status: 2026-06-23 DRAFT for review.** Decisions (Gary): **(1)** flat-`~` filesystem — no separate
> `/workspace`, the agent's home *is* its workspace; **(2)** **complete** the poll→daemon cutover (daemon-only,
> delete the in-pod poll). This note specs the target + the path to it. Companion:
> [`in-agent-poll-cutover-plan.md`] (cutover mechanics + status), [`shared-workspace-build-spec.md`],
> [[c4-overlay-capture-build]], [[agent-data-architecture]].

## 1. Decision & why

- **Flat-`~`.** The agent behaves like a normal Unix user: `$HOME` = its stuff (kept), `/tmp` = scratch
  (wiped). No `/workspace` mount, no "which dir is captured?" reasoning. Certain home subdirs are "special"
  (RO, or excluded, or separately mounted).
- **Complete the cutover.** Retire the in-pod Python poll (`artifact-capture`) entirely; the node daemon
  becomes the **sole** capture path. (Today the poll is the only *live* path; the daemon isn't deployed at all.)
- **Why flat-`~`:** cleaner agent UX; aligns with the planned `~/shared`,`~/repos`,`~/context` rename. **Cost,
  eyes open:** capturing home means capture must *exclude* all non-deliverables (auth, toolchain, caches) — §3
  makes that a single legible rule rather than an open-ended deny-list.

## 2. Target FS layout (what the agent sees)

```
/home/agent/   (= ~, the CWD; the agent's whole world)
  report.md, data.csv, …   ← CAPTURED: the agent's own deliverables (just files in home)
  shared/<channel>/         ← CAPTURED + co-edited (shared-workspace zone)
  repos/<owner>/<repo>/      ← RO lower (git owns code) — EXCLUDED from capture
  context/                   ← RO projection (today's /atrium: chat, sibling sessions, ledger) — EXCLUDED
  .claude, .codex, .state/   ← auth / harness / resume — EXCLUDED (separate mounts; dotfiles)
  .cargo,.bun,.config,.cache,.npm,.foundry,.pi … ← toolchain/config — EXCLUDED (dotfiles)
/tmp, /var/tmp               ← OS scratch, unchanged — uncaptured
```

## 3. The capture rule (one legible line)

**Capture = non-dotfile entries under `~`, except `repos/` and `context/`.**

- **Excluded by the rule:** everything starting with `.` (`.claude`,`.codex`,`.state`,`.cargo`,`.config`,
  `.cache`,…) — i.e. all auth + toolchain + config, the Unix convention for "plumbing"; plus the two named RO
  dirs `repos/` and `context/`; plus `/tmp`,`/var/tmp` (outside `~`, scratch).
- **Captured:** the agent's *visible* home files/dirs — its deliverables — and `shared/`.
- This replaces an open-ended toolchain deny-list with **"skip dotfiles + two RO dirs."** Cheap, legible, and
  it shrinks the exclude surface that was flat-`~`'s main cost.
- **Dir-naming cleanups required** (so the rule covers them): rename `~/state`→`~/.state`, `~/branches`→
  `~/.branches` (git plumbing). Decide `~/uploads`: keep visible if human-dropped files should be captured
  (likely yes), else `~/.uploads`.

## 4. Auth safety under flat-`~` (preserve the `#72 P4` guarantee)

Three layers, defense-in-depth:
1. **Structural:** mount `.claude`/`.codex`/`.state` as **separate volumes over the home volume**, so they are
   physically *not part* of the captured home upper — the same structural exclusion the `/workspace` model gives.
2. **Path rule:** they're dotfiles → excluded by §3 anyway.
3. **Content:** the daemon's secret-content scan (landed #15) blocks credential bytes even on a rule miss.

So auth is structurally + path + content protected — *stronger* than the old "structural only," which answers
the one real objection to flat-`~`.

## 5. /tmp (settled)

Stays OS scratch, uncaptured. No symlink, no `readOnlyRootFilesystem` dependency. Deliverables go in `~`.
(Optional, independent later hardening: `readOnlyRootFilesystem: true` + a writable `/tmp` emptyDir.)

## 6. Cutover path to daemon-only (adapts `in-agent-poll-cutover-plan §2`)

Phase 0 parity filters are DONE, gated (#15 secret/junk/`.git`, #16 repo-tree exclusion).

1. **Entrypoint → flat-`~`** (extends the gated `CENTAUR_OVERLAY_ENABLED` seam, #14): CWD=`~`; repo as RO
   lower at `~/repos/…`; auth/state as separate mounts; drop the `~/workspace` clone + forced `agent-<ts>`
   branch; apply the §3 dir-renames.
2. **Daemon home-capture:** point the daemon at the session-keyed home volume with the §3 rule (skip dotfiles +
   `repos/`+`context/`). Both lanes — artifact **and** harness-transcript.
3. **Live-wire the daemon** (controller `overlay: Some`, `nodeSync.enabled`) — not deployed today.
4. **Validate on a real cluster:** a home deliverable IS captured; a `repos/` edit is NOT; dotfiles/auth/
   toolchain/`/tmp` are NOT; the transcript IS captured + cold-start resume works.
5. **Parity bake** (poll vs daemon), **flip** `ARTIFACT_CAPTURE_ENABLED=0` with rollback, **delete** the poll
   + the orphaned Centaur `/agent/executions/{id}/artifacts` route.

## 7. Open questions (for review)

- **Overlay mount point:** overlay-mount *all* of `~` (lower = image home + repo + hydrated) vs. capture-scan
  `~` with the §3 rule and overlay only the `repos/` subtree. **Lean: capture-scan home + overlay only repos/
  hydration** — simpler, avoids shadowing the image-baked home (`.cargo` etc. are image layers).
- **Exclude rule = deny vs allow:** "non-dotfile minus repos/context" (§3, deny-ish) vs. an explicit allow-list
  of deliverable roots (`~` top-level + `~/shared`). Allow-list is safer (default-exclude) but slightly less
  "just your home." **Lean: §3 dotfile rule** (legible) with the secret-scan as the safety net.
- **Deliverable discoverability:** with no named "workspace," how do humans/UI distinguish deliverables? The
  ledger already keys by path and the UI shows captured paths, so "your visible home files" maps cleanly — but
  confirm the Files surface reads well under home-rooted paths.
