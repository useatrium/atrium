# Warm pool for repo-bearing sessions (#141) — build plan

> **Status: PLAN (2026-06-28).** Executable build plan for gbasin/atrium#141, integrating three
> strands that all need the same "compose-a-session's-repos-into-a-claimed-warm-pod" primitive:
> 1. **Warm-pod boot for repo sessions** — the original #141 (claim a generic warm pod, bind repo +
>    cache post-claim). De-risked by `warm-pool-repo-spike.md` (verdict **GO**).
> 2. **Overlays-into-`~/repos`** — `overlays-into-repos-plan.md` (folded in here, per its decisions).
> 3. **AGENTS.md → read-only lower** — deferred from the flat-home cleanup (#170-172); resolved for
>    free by the generic-HOME-as-a-lower step below.

## Already validated (spike GO)
- **Submount-at-HOME** under flat-home: mounting the session overlay **at `/home/agent`** (a submount
  under a `shared` `/home`) on a running warm pod propagates in and flips `$HOME` live.
- **Compose generic HOME as a read-only lower** beneath the repo (`lowerdir=<generic-home>:<repo>`):
  the merged HOME = repo files + harness config (`~/.codex`,`~/.claude`,`~/.config/amp`,`~/AGENTS.md`).
  POC'd with the real `centaur-agent` image (`codex`/`claude` run in the composed HOME).
- Per-session secrets live at the iron-proxy, **not HOME** → the warm pod's HOME is generic + reusable.

## Build phases (each independently landable + green)

### Phase 1 — Generic shared `/home` in the warm spec
Warm pod's HostToContainer volume becomes the **parent of HOME** (`/home`), a `shared` mountpoint,
with `/home/agent` present-but-empty; pod stays Ready as a generic shell. (Today the warm/flat-home
spec mounts the overlay AT `/home/agent`; move it up one level so a post-claim submount can land.)

### Phase 2 — Post-claim compose + bind + readiness handshake (`centaur-session-runtime`)
In the post-claim window: write the claimed session's manifest; the daemon mounts the composed
overlay **at `/home/agent`** (submount under `/home`): `lowerdir = <generic-home> : <repos…> :
<warm-cache>`, upper chowned to the agent uid. Then a **readiness handshake** (block until the
submount is visible) before the first turn — mirror the iron-proxy "apply + wait" barrier.
- **Fail-closed:** if the bind fails, **release the warm pod + cold-spawn** — never serve a half-bound pod.
- **Context submount:** re-establish `/home/agent/context` (RO `/atrium`) under the bound HOME post-claim,
  or compose it as a lower.

### Phase 3 — Relax the warm-pool claim filter
Today: `session_repos_json.is_none()` (`lib.rs:1967`). Change to **"no *working* repo"** — keep
env/persona/resume exclusions (personas dormant). This lets repo-bearing **and** org-default-only
sessions claim warm pods (required once every session carries org-default repos, Phase 4).

### Phase 4 — Overlays-into-`~/repos` (see `overlays-into-repos-plan.md`)
- Chart: build `CENTAUR_OVERLAY_REPOS_JSON` from `overlays.sources`; repoint
  `CENTAUR_SKILL_DIRS`/`KUBERNETES_WORKFLOW_DIRS` `/home/agent/github` → `/home/agent/repos/<owner>/<repo>`.
  `TOOL_DIRS`/`WORKFLOW_DIRS` (host) unchanged.
- API: merge org-default ∪ per-session repos into **every** session's composed set (dedup, working-wins).
- **Drop the `~/github` mount** (`SANDBOX_REPOS_MOUNT_PATH`, `args.rs`). Reference repos come via the
  per-session set; update the centaur AGENTS.md `~/github/vercel/chat` note.
- Repos editable + committable; **tool** changes go live only after merge + an operator credential
  grant (trust boundary). `repos/` already capture-excluded (#171).

### Phase 5 — AGENTS.md → read-only lower (closes the cleanup deferral)
The generic-HOME composed as a read-only lower (Phase 2) **already carries `~/AGENTS.md`** (base +
org-overlay `SYSTEM_PROMPT`; persona is dormant, so it's genuinely generic). So `~/AGENTS.md` becomes
read-only **and** out of the captured upper for free — superseding the #170 denylist belt-and-suspenders
(keep the denylist as defense-in-depth). No separate API→daemon prompt-delivery needed; it rides the
warm pod's generic-home snapshot.

### Phase 6 — e2e
Real-pod test driven by the actual daemon (Bidirectional volume) + the post-claim path. Assert: first
turn runs with `$HOME` == the composed home; working + org-default repos writable at
`~/repos/<owner>/<repo>`; `~/AGENTS.md` present but absent from the overlay upper / `state.json`;
no `~/github`; warm-pool claim succeeds for a repo-bearing session.

## Decisions locked (spike + overlays threads)
- Topology single-node now (locality free for v1); claim any warm pod + cross-node CAS pull on a cold node.
- Eligibility: repos only (no per-repo idle pools — one generic pool, no per-repo idle cost).
- Value = pod-boot seconds (interactive snappiness); measure pod-boot in prod to size it.
- Overlays: `overlays.sources` repurposed as the org-default repo set; drop `~/github`; working-wins
  on collision; editable+committable with tool-credential gating retained.

## Risks / open
- HOME-setup vs post-claim submount (the main integration wrinkle — resolved in design, validate in e2e).
- Upper ownership: chown to agent uid before the bind (daemon `prepare_upper_and_merged` already does).
- `codex` logs `could not create PATH aliases: Permission denied` under the composed HOME (harmless;
  ensure its target dir is writable).
- Per-repo prebuilt pools (build-plan §7 "Full") — explicitly **not** this work.
