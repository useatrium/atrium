# Flat-home `~` directory cleanup + capture-pollution fix — build plan

> **Status: PLAN (2026-06-28).** Pre-work for the warm-pool-repo build (gbasin/atrium#141).
> Grounded in: live-cluster empirical confirmation (kind `centaur`, flat-home default),
> committed code review, and design-intent archaeology via `cass` over prior agent sessions
> (git history was flattened by the subtree vendor `a25fb9e`, so `cass` is the intent record).

## Why this exists

While reviewing the (non-)clobbering of repo `AGENTS.md`, we found the real issues are in the
flat-home `~` layout, not a clobber:

1. **No clobber, but capture pollution.** Session repos nest at `~/<basename>`; centaur's
   `~/AGENTS.md` is written fresh to the overlay **upper** by `entrypoint.sh:508-512` and is
   classified **Artifact** by the capture daemon — it lands in the captured layer.
2. **Repo layout is collision-prone** (`~/<basename>`): a repo named `state`/`uploads`/`context`,
   or two repos with the same basename from different owners, collide at `~`.
3. **Stale / vestigial dirs** at `~` top level: `uploads/` (superseded by the shared-scope upload
   path), `state/` (legacy persistent-state PVC; should be a dotfile), `github/` (org-overlay mount),
   plus fixture cruft (`seed.txt`/`delete-me.txt`) in repo-less sessions.

## Empirical findings (live cluster, flat-home = default `values.yaml:504`)

Ran the real `provision-overlay` binary in the node-sync pod with one repo:

```
overlay-lower/<session>.repos/
  centaur/            ← the repo, nested under its basename (NOT flat at ~, NOT ~/github)
  centaur/AGENTS.md   ← repo's own AGENTS.md (41 KB), untouched
  AGENTS.md           → does not exist at lower root
```

Real repo-less session's overlay **upper** (the captured layer):

```
AGENTS.md  22360 b  ← centaur's prompt — THE live pollutant (also tracked in state.json `paths`)
github/ context/ state/ uploads/ → 0 entries (empty mount-points; latent only)
```

A real session with deliverables (`asbx-…-2`) merged `~`:
`AGENTS.md  cutover-cas-smoke.md  shared/  context/  github/  state/  uploads/  seed.txt  delete-me.txt`

**Capture rule** (`runtime.rs:280` `classify_entry`): denied (`.ssh/.aws/.git`, `*credentials*`,
keys, `.pem/.key`, junk binaries `is_denied_path:374`) → dropped; `.claude/.codex/.claude.json`
→ harness-state lane; repo subdirs → dropped; **top-level dotfiles → dropped; everything else →
Artifact (uploaded to Atrium CAS).** So any non-dotfile top-level file the entrypoint writes
(today: `AGENTS.md`; for amp also `AGENT.md` symlink `entrypoint.sh:535`) is captured.

**Hydration layers:**
- **Lower** (read-only, **never scanned**): composed repos (`overlay_mount.rs` `materialize_repo_entry:447`),
  hydrated prior-session artifacts, warmcache deps. Assembled before the container starts.
- **Upper** (writable, **scanned + uploaded**): everything the agent *and the entrypoint* write to `~`.
- **Merged** = lower+upper, mounted at `~` (flat-home) — what the agent sees.

## Directory taxonomy — intent vs landed

| `~` entry | Purpose | Landed today | Intended (design doc / cass) | Action |
|---|---|---|---|---|
| `<basename>/` (e.g. `centaur/`) | session working repo | `~/<basename>` (`repo_target_subdir:208`) | `~/repos/<owner>/<repo>` (`flat-home-workspace-design.md:47`) | **move to `~/repos/<owner>/<repo>`** |
| `AGENTS.md` | centaur operating contract | written to **upper** → captured | read-only, not a deliverable | **move into the lower (Option A)** |
| `shared/` | server-owned aliases to shared scopes (`shared/channels/<id>/…`) | present, captured/browse | keep | keep |
| `context/` | RO projection of Atrium (chat, sibling sessions, ledger) | `atrium-context` mount at `~/context` (`lib.rs:1485`) | keep (RO) | keep; confirm excluded |
| `github/` | **org-overlay** repos (tools/workflows/skills/persona, `apirs.yaml:23-26`) | mount point, usually empty | keep but distinct from session repos | keep; document; don't conflate w/ `~/repos` |
| `state/` | legacy persistent-state plumbing | stray empty dir (PVC `stateVolume.enabled: false` by default `values.yaml:227`; symlink logic `entrypoint.sh:59-67` skipped in flat-home) | nothing in flat-home | **DROP it (not rename)** — it's vestigial; `.state` only matters if persistent-state is ever revived |
| `uploads/` | human-dropped attachments | `entrypoint.sh:499` mkdir (top-level) | uploads flow to `shared/channels/<id>/uploads/` (`messages.ts:91`) | **remove vestigial top-level mkdir** |
| `scratch/` | private per-session durable scope | path-mapping only (`http_client.rs:115` `scratch/<session>/`), dir on-demand | `~/scratch` (captured to `scratch/<session>/`) | keep; ensure materialized/visible |
| `seed.txt`,`delete-me.txt` | overlay fixture seed | visible in repo-less merged (`overlay_mount.rs:247`) | test fixture only | **don't seed when a real lower exists** |

Notes:
- **`~/state` is NOT the scratch dir.** `~/state` = harness/git persistent-state plumbing (legacy
  non-flat-home path symlinks `~/.codex`,`~/.claude`,`~/branches`,`~/workspace` under it,
  `entrypoint.sh:59-67`, skipped in flat-home). The private scratch dir is **`~/scratch`**.
- **`uploads` vs `context`:** different lifecycles — `context` is a RO system projection;
  uploads are inbound human attachments that already route to `shared/channels/<id>/uploads/`
  (a captured shared-scope path), so the standalone `~/uploads` mkdir is vestigial in flat-home.

## Decisions

- **Prompt capture (Phase 1):** **denylist now** — exclude the top-level contract files
  (`AGENTS.md`/`AGENT.md`) from capture in `classify_entry`. The clean **Option A** (assemble the
  prompt into a read-only lower) is **deferred to the warm-pool generic-HOME-lower build** (#141),
  because it needs new API→daemon prompt-delivery plumbing (the node-sync daemon has no
  `/opt/centaur/AGENTS.md`). The denylist fully stops the pollution today.
- **`~/repos/<owner>/<repo>`** for session repos (owner-scoped, collision-free, matches design).
- Capture rule keyed on **prefixes** (`repos/`, `context/`) + dotfiles, not dynamic basenames.
- Dir hygiene: **drop** vestigial `~/state` and top-level `~/uploads`, stop fixture-seeding real
  sessions. (`.state` rename is moot — nothing uses it in flat-home.)

## Implementation plan (phased; each phase independently landable + green)

### Phase 1 — Capture pollution: deny centaur `AGENTS.md` from capture ✅ (this PR)
**Denylist now; relocate-to-lower deferred to the warm-pool build** (see Decisions).
- **Exclude the contract files from capture** in `classify_entry` (`runtime.rs`): a top-level
  (single-component) `AGENTS.md` / `AGENT.md` → `Denied`. A repo's own nested `AGENTS.md` stays
  handled by the repo-subdir denial; a deeper deliverable like `notes/AGENTS.md` is still captured.
  Covered by the `classify_entry_denies_top_level_centaur_prompt_files` unit test.
- **Deferred (with warm-pool, #141):** relocate the assembled prompt into a read-only lower so
  `~/AGENTS.md` is read-only too. Needs the API to assemble (base `/opt/centaur/AGENTS.md` + org
  overlay `CENTAUR_OVERLAY_DIR/.../SYSTEM_PROMPT.md`; persona is dormant, so nothing per-session to
  thread) and deliver it to the daemon via a `SessionManifest` field.
- **Verify (this phase):** unit test asserts the classifier denies the top-level contract files and
  still captures genuine deliverables; full node-sync suite green (126 tests). Live-cluster baseline
  already confirmed the *pre-change* daemon tracks `AGENTS.md` in `state.json`. A full
  spawn→execute→capture cluster e2e is disproportionate here (node-sync image rebuild + a
  token-spending agent execution to populate the upper); Centaur CI re-runs the suite.

### Phase 2 — Session repo layout → `~/repos/<owner>/<repo>`
- `repo_target_subdir` (`overlay_mount.rs:208`): return `<owner>/<repo>` (full relative repo path),
  not basename. Keep the explicit `subdir` override.
- Composition target + collision detection (`plan_repo_composition:163-206`): nest under `repos/`.
- `classify_entry` repo-subdir denial (`runtime.rs:294`): switch from per-basename `repo_subdirs`
  to the single `repos/` prefix (+ keep `context/`). Update `partition_entries_by_lane` callers and
  `repo_subdirs` construction.
- Entrypoint working dir: keep `cwd = ~`; document that the active repo is `~/repos/<owner>/<repo>`.
- `SYSTEM_PROMPT.md` identity block (`services/sandbox/SYSTEM_PROMPT.md:4-6`): change
  `~/github/{org}/{repo}` → `~/repos/{owner}/{repo}` for **session** repos; keep `~/github/...`
  language only where it genuinely means org-overlay repos (or rename those too — decide in Phase 4).
- **Verify:** spawn single + two same-basename repos (`acme/x` + `globex/x`); assert
  `~/repos/acme/x` + `~/repos/globex/x` and no composition collision error.

### Phase 3 — Dir hygiene
- Remove the vestigial top-level `uploads` mkdir (`entrypoint.sh:499`); confirm uploads still land
  via `shared/channels/<id>/uploads/`.
- Rename `~/state` → `~/.state` (and `~/branches`→`~/.branches`) in the legacy persistent-state path
  (`entrypoint.sh:59-67`); evaluate dropping the 10 Gi `StateVolumeConfig` PVC for flat-home sessions
  (it is unused there).
- Stop fixture-seeding (`seed.txt`/`delete-me.txt`) when a real repo/artifact lower exists
  (`overlay_mount.rs:247` — gate to Fixture-kind test sessions only).
- Ensure `~/scratch` is materialized/visible (it has a capture mapping but no created dir in the
  sessions inspected).

### Phase 4 — Docs + tests
- Update `flat-home-workspace-design.md` (the `~/repos/<owner>/<repo>` + capture-prefix rule are now
  implemented, not aspirational) and the warm-pool spike doc (its "today's flat-home clobbers the
  repo's AGENTS.md" claim is **false** — repos nest; centaur's `~/AGENTS.md` and the repo's
  `~/repos/<owner>/<repo>/AGENTS.md` are distinct paths).
- Update/extend unit tests: `compose_plan_maps_repos_to_cache_and_workspace_subdirs`,
  `classify_entry_*`, `compose_plan_rejects_target_collisions_and_traversal`, and add a
  capture-exclusion test for top-level `AGENTS.md`.

## Design direction — overlays as RW committable repos under `~/repos/` (Pi-inspired)
Open question raised: instead of read-only deployment overlays at `~/github/<org>/<repo>`, make them
**RW repos under `~/repos/` the agent can edit + commit like any code** (Pi-harness style). Tracing
what would actually happen, component by component (the overlay has two distinct consumers):

| Overlay part | Loaded from | If RW under `~/repos/` |
|---|---|---|
| **Skills** (`CENTAUR_SKILL_DIRS`) | agent container (`/home/agent/github/...`) | ✅ agent edits + `install-tool-shims --refresh-skills` → live in-session. Pi-like, low-risk. |
| **System prompt** (`CENTAUR_OVERLAY_DIR/SYSTEM_PROMPT.md`) | agent container | ✅ committable; takes effect next session boot (prompt is assembled at boot). |
| **Sandbox workflows** (`KUBERNETES_WORKFLOW_DIRS`) | agent container | ✅ mostly live. |
| **Tools + API workflows** (`TOOL_DIRS`/`WORKFLOW_DIRS`) | **host repo-cache → api-rs pod** (`hostPath`, `apirs.yaml:22,37`) | ⚠️ the API can't see the agent's container FS. Agent edits only land after **commit → push → repo-cache re-mirror → API hot-reload**. Committable-as-code, but not live in-container. |
| **Tool credentials** (iron-control `tool-<slug>` grants) | iron-proxy MITM injection | ⛔ **stays operator-gated** — an agent-authored tool runs with *no* creds until an operator grants it (`centaur-perms`). This is the trust boundary, and the real reason overlays are deployment-RO. Pi has no multi-tenant MITM cred model; Atrium does. |

**Synthesis (a coherent unification):** treat *all* git-managed code — working repos **and** the
agent's own tooling overlays — as RW committable repos under `~/repos/<owner>/<repo>`, git-versioned,
**excluded from artifact-capture** (the `repos/` prefix; git owns their history). "Overlay" stops
being a separate top-level dir and becomes "a repo in the set whose subdirs are registered as
tool/skill/workflow paths." The agent gets the full Pi-style self-editing loop for skills/prompts
**immediately**; tool/workflow changes are committable-as-code with a commit→re-mirror reload lag;
and **credentialed** tool changes go live only after merge + grant (safe self-extension).
This is a **direction beyond the cleanup** — sequence it after Phases 1–3. The cleanup should at
minimum stop `~/github` overlays leaking into capture (today they're non-dotfile → Artifact when
non-empty); folding them under `~/repos/` solves that for free.

## Sequencing vs the warm-pool-repo build
Phase 1 (AGENTS.md → lower) is the shared primitive with the warm-pool-repo build (generic-HOME
lower). Do Phases 1–3 first as the cleanup, then the warm-pool-repo build layers the
generic/per-session lower split (the deferred Phase-1 note) on top.

## Persona path — RESOLVED (dormant; simplifies Option A)
Traced the persona path: persona is selected, validated, recorded in `sessions.persona_id`, and
passed to the sandbox **only as env** (`AGENT_PERSONA`, `CENTAUR_PERSONA_ID`,
`CENTAUR_PERSONA_PROMPT_HASH`, `CENTAUR_PERSONA_SOURCE_PATH/_REF` — `apply_persona_spec_env:4380`).
`PersonaDefinition.prompt` carries the text but is used **only in a test** (`lib.rs:5422`). **No
sandbox code consumes the persona env**, and **nothing writes `AGENTS_BASE.md` or the "[Active
deployment]" block** the SYSTEM_PROMPT self-introspection section references. So persona-prompt
injection is **dormant/unwired** in this fork. Consequences:
- The effective `~/AGENTS.md` today = baked `/opt/centaur/AGENTS.md` (+ org-overlay `SYSTEM_PROMPT.md`
  when `CENTAUR_OVERLAY_DIR` set). No persona text, no per-session prompt content.
- **Option A is simpler than feared:** the lower-assembled prompt has no session-varying persona to
  thread through, so a single assembled `AGENTS.md` in the lower is fully correct, and the
  warm-pool generic/per-session split is *not* needed for persona (there's nothing to split).
- **Separately flag:** persona selection is a latent no-op — worth a follow-up to either wire it or
  remove the dead env/DB plumbing. Out of scope for this cleanup.

## `<owner>` segment — KEEP IT (multi-repo shared sessions are a goal)
The *surface* sends one repo today (`session-runs.ts:2131`), but the runtime composition already
supports N (`plan_repo_composition`), and the goal is **sessions with a set of mounted repos**
(working + reference + the agent's own tooling). With multiple repos, same-basename-different-owner
collisions are real, so **`~/repos/<owner>/<repo>`** is the right layout. Follow-on surface change:
let a session specify a repo *set* (not just one) → multiple `RepoSpec`s in the spawn `repos` array.

## Open items to confirm during build
- Whether the captured `AGENTS.md` is currently **surfaced to users** in Atrium vs merely tracked
  (surface server wasn't running in the inspected cluster; it is in the Artifact lane with `base_seq:1`).
