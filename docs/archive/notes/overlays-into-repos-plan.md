# Org-overlays as writable repos under `~/repos/` — scoped plan

> **Status: PLAN — decisions locked 2026-06-28; folds into the warm-pool-repo build (#141).**
> Goal (Gary): stop mounting org-overlay repos read-only at `~/github`; put **all** of a session's
> repos — working repo *and* org-overlay/reference repos — as **writable** copies under
> `~/repos/<owner>/<repo>` (the Pi model: agent can edit + commit any of them). Builds on the
> flat-home dir cleanup (#170-172). Validated below by hand-compute + stress-test.

## Decisions (locked 2026-06-28)
1. **Sequencing:** fold the whole thing into the **warm-pool-repo build (#141)** — one
   compose-repos-post-claim code path, `~/github` dropped in one shot (no two-mode interim).
2. **Drop `~/github` for everyone.** All sessions (incl. generic/warm) **default to a minimum set
   of org-level repos**, composed writable. This *requires* relaxing the warm-pool claim filter
   (below) — which is exactly why it folds into #141.
3. **Two complementary repo inputs**, union'd in `~/repos` (dedup, session-wins):
   - **Org-default set** = **`overlays.sources` repurposed** (decision 5) — auto-composed into
     *every* session; the Q2 baseline.
   - **Per-session set** = working repo + *optional* reference repos the caller names.
4. **Collision:** when a working repo == an org-default repo, **working repo wins** (its ref).
5. **Config:** repurpose **`overlays.sources`** as the org-default repo list — its repos compose
   writable, its `tools/workflows/skills` subdirs keep wiring `TOOL_DIRS` (host) + skill/workflow
   dirs (now → `~/repos/<owner>/<repo>/<subdir>`). No new config surface.
6. **Writes:** org-default repos are **editable + committable** (full Pi model). Skills/prompts go
   live in-session on edit; **tool changes go live only after merge + an operator credential
   grant** — that gate stays (the trust boundary), it's not a read-only-ness thing.

## Why `~/github` is read-only today (the core constraint)
`~/github` (`SANDBOX_REPOS_MOUNT_PATH`, `args.rs:43`) is **one read-only bind-mount of the node's
shared repo-cache** (`/var/lib/centaur/repos`) — the same mirror every session/pod on the node
clones from. It can't be made writable in place: one session writing it would corrupt the shared
mirror for everyone. "Writable" therefore means a **per-session copy**, which is exactly what
`~/repos` already does (daemon reflinks the repo out of the mirror into the overlay lower; the
overlay upper makes it writable). So the move is: compose the overlay repos into the session set too.

## The two distinct overlay delivery paths (don't conflate)
1. **`overlays.sources`** (repo-cache-backed tools/workflows/skills) — feeds:
   - **API host-side:** `TOOL_DIRS` + `WORKFLOW_DIRS` = `<repoCache.hostPath>/<repo>/<subdir>` (the
     api-rs pod discovers + serves tools/workflows from the host mirror). **Unaffected by this change.**
   - **Sandbox-side:** `CENTAUR_SKILL_DIRS` + `KUBERNETES_WORKFLOW_DIRS` = `/home/agent/github/<repo>/<subdir>`,
     resolved by the `~/github` mount. **This is what moves to `~/repos`.**
2. **`overlay.systemPrompt`** → `CENTAUR_OVERLAY_DIR=/app/overlay/org` (a separate prompt mount, not
   under `~`). The entrypoint appends `${CENTAUR_OVERLAY_DIR}/services/sandbox/SYSTEM_PROMPT.md`.
   **Independent of `~/github`** (chart default `/app/overlay/org`); out of scope, except the
   documented option to point it at a `~/repos/<owner>/<repo>` path instead.

## Hand-compute — happy path (repo-bearing session)
Deployment: `overlays.sources = [acme/centaur-overlay]`. Session working repo: `me/proj@feature-x`.

| Step | State |
|---|---|
| surface spawn | `centaur_session_repos = [{me/proj, ref:feature-x}]` |
| **API merge (NEW)** | working ∪ overlay → `[{me/proj@feature-x}, {acme/centaur-overlay}]` → `AGENT_REPOS_JSON` |
| spec | `AGENT_REPOS_JSON` set; **no `~/github` mount**; `CENTAUR_SKILL_DIRS=~/repos/acme/centaur-overlay/.agents/skills`, `KUBERNETES_WORKFLOW_DIRS=~/repos/acme/centaur-overlay/workflows` |
| daemon compose | lower gets `repos/me/proj` (checked out feature-x) + `repos/acme/centaur-overlay` (default ref), both **writable** via overlay upper |
| agent view | `~/repos/me/proj` (writable) + `~/repos/acme/centaur-overlay` (writable); both git-versioned, capture-excluded (`repos/` denial from #171) |
| skills/workflows | sandbox-side, read from `~/repos/acme/centaur-overlay/...` (live on `--refresh-skills`) |
| tools | API host-side `TOOL_DIRS` (unchanged); agent edits to overlay `tools/` go live only after commit→push→re-mirror→API reload, and creds need a grant (trust boundary) |

Happy path works and reuses the ComposedRepos machinery (#171), proven by the Phase 2 live e2e.

## Stress-test — failure modes found
| # | Scenario | Outcome | Resolution |
|---|---|---|---|
| **S1** | working repo == an overlay repo (same `owner/repo`) | both → `repos/<owner>/<repo>` → `plan_repo_composition` **collision error** (`seen_specs` only dedups exact `(repo,ref,subdir)`, so differing refs both compose) | **API merge dedups by repo path; working-set entry wins** (its ref) before building `AGENT_REPOS_JSON` |
| **S2** | overlay pins `ref=main`, working repo wants `feature` | S1 collision | working ref wins; overlay tool/skill dirs then read the working copy (same repo) — acceptable |
| **S3** | overlay repo not yet in the node mirror | `copy_repo_from_cache` falls back to `clone_repo` (github.com, needs net/auth) | same as today's mount; pre-mirror overlays; note the fallback |
| **S4** | reference repos gone (e.g. `~/github/vercel/chat`) — centaur AGENTS.md tells agents to read it | dropping `~/github` removes implicit access to *all* mirrored repos | reference repos must be **named in the session set** (explicit > implicit); update AGENTS.md note. Common refs can be added to `overlays.sources` so they always compose |
| **S5** | every session reflinks M overlay repos | N×M copies | reflink CoW ≈ free; warmcache amortizes; note |
| **S6** | `overlays.sources` now consumed in two places (host `TOOL_DIRS` **and** the new session-set injection) | drift risk | chart builds **one** `CENTAUR_OVERLAY_REPOS_JSON` env from `overlays.sources`; session-runtime merges it — single source |
| **S7 ⚠️** | **inject overlay repos into *every* session → `session_repos_json` is always `Some` → warm-pool claim filter (`session_repos_json.is_none()`, `lib.rs:1967`) never matches → warm pool disabled for ALL sessions** | **major regression** | **see "warm-pool coupling" — forces the A/B split** |

### The S7 crux (warm-pool coupling)
Org-overlays are **deployment-generic** (every session, including the repo-less Slack-bot sessions
the **warm pool** serves). Today generic/warm sessions get overlay skills/workflows from the
deployment-wide `~/github` mount on the warm pod — a perfect fit (generic, shared, repo-agnostic).
Per-session composition breaks that: it sets `session_repos_json`, which the warm-pool filter
rejects. So we **cannot** both (a) compose overlays per-session for generic sessions and (b) keep
the warm pool — without changes to the warm-pool path itself.

## Design (locked — one build, folded into #141)
Every session composes: **org-default repos** (`overlays.sources`) ∪ **per-session repos**
(working + optional), deduped (working/session wins), all writable under `~/repos/<owner>/<repo>`.
`~/github` is removed. Concretely:

1. **Chart:** build one `CENTAUR_OVERLAY_REPOS_JSON` from `overlays.sources` (repos + refs); repoint
   `CENTAUR_SKILL_DIRS`/`KUBERNETES_WORKFLOW_DIRS` from `/home/agent/github/<repo>` →
   `/home/agent/repos/<owner>/<repo>/<subdir>`. `TOOL_DIRS`/`WORKFLOW_DIRS` (host-side) unchanged.
2. **API (`session-runtime`):** merge `CENTAUR_OVERLAY_REPOS_JSON` into **every** session's composed
   set (dedup-by-repo, working/session entry wins), so even generic sessions carry the org-default
   repos → `AGENT_REPOS_JSON`.
3. **Warm pool (the #141 coupling):** because every session now has repos, relax the claim filter
   from `session_repos_json.is_none()` to **"no *working* repo" (org-default-only is still
   claimable)**, and compose the org-default repos into the **warm pod's generic home** post-claim
   (the #141 primitive) so warm/generic sessions get them too.
4. **Drop the `~/github` mount** (`SANDBOX_REPOS_MOUNT_PATH`, `args.rs`). Reference repos beyond the
   org default come via the per-session set (update the centaur AGENTS.md `~/github/vercel/chat` note).
5. **Writes/creds:** repos are writable + committable; skills/prompts live on `--refresh-skills`;
   **tool** changes only go live after merge → re-mirror → API reload **+ an operator credential
   grant** (the trust boundary). Capture already excludes `repos/` (#171), so git owns their history.

## File-level touch points
- `crates/centaur-api-server/src/args.rs` — drop/condition `SANDBOX_REPOS_MOUNT_PATH` mount (B);
  read `CENTAUR_OVERLAY_REPOS_JSON`.
- `crates/centaur-session-runtime/src/lib.rs` — merge overlay repos into the composed set (A:
  repo-bearing only); dedup-by-repo; (B) relax warm-pool filter to working-repo-only.
- `contrib/chart/templates/apirs.yaml` — build `CENTAUR_OVERLAY_REPOS_JSON`; repoint skill/workflow
  dirs `/home/agent/github` → `/home/agent/repos`.
- `services/sandbox/SYSTEM_PROMPT.md` + `centaur/AGENTS.md` — reference-repo note `~/github` → `~/repos`.
- Tests: compose dedup/collision (S1), warm-pool filter (S7), classify already covers `repos/`.

## Open decisions — RESOLVED (see "Decisions" at top)
All four walk-through questions + two follow-ups answered 2026-06-28: fold into #141; drop
`~/github`, all sessions default to org repos; `overlays.sources` repurposed as the org-default
set; per-session set for optional/reference repos; working-repo wins collisions; repos editable +
committable with tool-credential gating retained.

**Next step:** this scope is now part of the **#141 warm-pool-repo build** (it needs the warm-pod
compose + claim-filter relax). Build it there, not standalone.
