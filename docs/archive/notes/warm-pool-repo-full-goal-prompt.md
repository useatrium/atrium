# Warm Pool Repo Sessions — Full Goal Prompt

Use this prompt to land the full warm-pool repo-session implementation, including the missing
post-claim overlay primitive and Atrium UI.

```text
You are working in /Users/garybasin/Code/atrium.

Goal: land the full warm-pool repo-session implementation, not just the conservative org-default
v1. Build the missing post-claim overlay primitive, wire it through Centaur, add Atrium frontend
affordances so users can actually request/use repo behavior, test it end-to-end in browser and on
real Linux VM/pods, then land phased commits to master.

Execution model: create a fresh implementation worktree from current `origin/master` before
editing, and use agent-fanout/subagents throughout the build. Do not work from a stale or dirty
shared checkout. Keep implementation pieces in phased commits, with subagent review for each major
piece before it lands.

Important context:
- Repo guide: Atrium surface lives in surface/. Centaur lives in centaur/ as a managed subtree.
  Follow AGENTS.md, centaur/AGENTS.md, and centaur/ATRIUM_FORK.md.
- Existing related commits on origin/master:
  - 1efd234 #170 AGENTS/AGENT capture denylist
  - 71d17d6 #171 session repos under ~/repos/<owner>/<repo>
  - 416c833 #172 drop vestigial ~/uploads
  - 2c410bc #173 plan docs
  - 22a3299 org-default repos into sandbox specs
  - 62cd943 overlay repos through ~/repos
  - 6216561 warm org-default repo tests
  - 60c00c6 git-branch from ~/repos
- The current landed state is conservative v1 only:
  - org-default repos can be in warm specs up front
  - explicit working/session repos still cold-spawn
  - missing: warm-claim post-claim repo compose/bind primitive

Primary plan docs:
- docs/archive/notes/warm-pool-repo-build-plan.md
- docs/archive/notes/overlays-into-repos-plan.md
- docs/archive/notes/warm-pool-repo-spike.md

Required outcome:
1. Warm pods support repo-bearing sessions through post-claim compose/bind.
2. Explicit working repo sessions can claim a generic warm pod.
3. Org-default repos and session/working repos compose under ~/repos/<owner>/<repo>.
4. Working/session repo wins collisions.
5. First agent turn must not start until composed HOME is mounted and ready.
6. On post-claim bind failure: release/retire the warm pod and cold-spawn instead. Never serve a
   half-bound pod.
7. Atrium frontend exposes usable UI/UX affordances for selecting/confirming repo behavior.
8. Real browser e2e and real Linux VM/pod e2e pass.
9. CI is green on the landed branch/master before declaring the goal complete.
10. Land to master in phased commits, each reviewed by subagents.

Phase A: Re-read and verify current state
- Start in a fresh worktree from current origin/master.
- Confirm current branch/worktree cleanliness before edits.
- Inspect current warm pool, sandbox backend, node-sync, overlay manifest, chart, surface session
  creation, and frontend flows.
- Use subagents for independent code review/context:
  - runtime/warm-pool reviewer
  - node-sync/overlay mount reviewer
  - k8s/chart reviewer
  - surface/frontend reviewer
  - e2e/Linux VM reviewer
- Do not assume the existing plan is sufficient. Hand-compute the claim flow:
  cold session, warm org-default-only session, warm working-repo session, failure fallback,
  collision case, resume case.

Phase B: Build the missing post-claim primitive
- Add a backend/runtime operation along the lines of:
  prepare_claimed_overlay_home(sandbox_id, thread_key, execution_id, repos_json, harness metadata,
  agent uid, etc.)
- It must:
  - write/update the node-sync session manifest for an already-running claimed warm pod
  - cause node-sync to compose/mount overlay at /home/agent
  - include generic HOME as a read-only lower so ~/.codex, ~/.claude, ~/.config/amp, ~/AGENTS.md
    survive
  - include repos under ~/repos/<owner>/<repo>
  - preserve/re-establish /home/agent/context or compose it correctly
  - wait for readiness marker/submount visibility before ensure_session_pipe
  - return a structured error on failure
- Implement in the backend-neutral trait only as needed, with Unsupported fallback for non-k8s
  backends.
- Implement for agent-k8s/node-sync path.
- Add focused unit tests for backend operation shape and runtime sequencing.

Phase C: Warm pod shared /home topology
- Warm flat-home pods must mount shared parent /home with HostToContainer propagation.
- /home/agent must be present enough for the generic warm agent process to boot.
- Cold flat-home behavior must not regress.
- Add tests proving:
  - cold flat-home still mounts /home/agent
  - warm flat-home mounts /home parent
  - workingDir remains /home/agent
  - post-claim mount lands at /home/agent

Phase D: Relax warm-pool filter fully
- Change warm-pool claim eligibility from "no session repos" to the intended repo-aware rule.
- Final behavior:
  - org-default-only sessions warm-eligible
  - explicit working repo sessions warm-eligible if post-claim overlay operation is supported
  - fallback cold-spawns if warm pool miss or post-claim bind failure
  - preserve existing exclusions for harness mismatch, persona-specific sessions, custom
    environment, resume constraints unless deliberately updated
- Add tests for:
  - working repo session claims warm pod
  - warm miss cold-spawns with same composed repo JSON
  - post-claim bind failure cold-spawns and records event/metric
  - no duplicate AGENT_REPOS_JSON

Phase E: Complete overlays into ~/repos behavior
- Keep ~/github removed from active agent-facing paths.
- Ensure:
  - chart renders CENTAUR_OVERLAY_REPOS_JSON
  - CENTAUR_SKILL_DIRS and KUBERNETES_WORKFLOW_DIRS use /home/agent/repos
  - host TOOL_DIRS/WORKFLOW_DIRS remain repo-cache host paths
  - repo-cache mount for warmcache remains separate, e.g. /cache
  - git-branch and entrypoint work from ~/repos
- Add/adjust tests for chart/rendering and sandbox envs.
- Do not edit upstream-owned centaur docs for Atrium-specific guidance. Use fork-specific docs or
  sandbox prompt where appropriate.

Phase F: Atrium frontend/product UI
- Inspect current session creation UX in surface/web and server APIs.
- Add UI/UX affordances for users to use this functionality. The UI should make repo behavior
  explicit and usable, not hidden:
  - show/select working repo and branch/ref where applicable
  - show org-default repos that will be available
  - distinguish "working repo" from "available reference/org repos"
  - show warm-pool eligibility/status if available without noisy implementation detail
  - surface clear copy for where repos will appear: ~/repos/<owner>/<repo>
  - handle empty/loading/error states
- Implement necessary surface server/client changes.
- Add focused tests for server request mapping and frontend behavior.
- Use existing design system/components. Avoid marketing/landing-page style. This is operational
  product UI.

Phase G: Linux VM / local Mac e2e
- The real node-sync mount-propagation e2e is not valid on Docker Desktop kind/linuxkit. Use `cass`
  to search prior repo/session history for how Linux VMs were used from this Mac.
- Find and document the working Linux VM path.
- Update readmes/scripts so future agents can run this without rediscovering it:
  - how to start/provision the Linux VM
  - how to build/load images
  - how to run kind/k8s inside or against the VM
  - how to run the warm-pool repo e2e
  - common failure diagnostics
- Run real Linux VM/pod e2e:
  - warm pod exists
  - working repo session claims warm pod
  - post-claim compose/bind succeeds
  - first turn sees HOME=/home/agent
  - repos writable at ~/repos/<owner>/<repo>
  - no active ~/github dependency
  - AGENTS.md present and not captured into upper/state
  - fallback cold-spawn path works when bind fails or warm miss is induced
- Keep e2e artifacts/logs summarized in final answer.

Phase H: Browser e2e
- Start Atrium surface normally from surface/.
- Run server/web/e2e as appropriate.
- Use browser automation to test the actual UI:
  - create/start a repo-backed session through the frontend
  - confirm repo selection UI
  - confirm backend payload includes intended repo metadata
  - confirm user-visible session state reflects repo availability/warm claim where designed
- Capture screenshots or browser test output if useful.
- Fix UI jank/layout issues discovered during browser testing.

Phased commit/review discipline:
- Commit in logical pieces, for example:
  1. runtime/backend post-claim overlay API
  2. k8s/node-sync manifest/bind/readiness implementation
  3. warm-pool eligibility/fallback behavior
  4. chart/sandbox prompt/path cleanup
  5. surface server/API repo metadata support
  6. frontend repo selection/status UI
  7. e2e scripts/docs for Linux VM
  8. tests/e2e hardening
- After each major piece, run focused tests and ask subagents to review the diff.
- Address must-fix findings before moving on.
- Do not squash; preserve phased commits.
- Before landing, run full relevant local verification and final subagent review.
- Land to master only after tests pass or blockers are explicitly understood. If direct push is
  used, verify it is a fast-forward from origin/master.
- After landing/pushing, monitor GitHub CI until required checks are green. If CI fails, inspect logs,
  fix in follow-up phased commit(s), rerun focused local tests, push, and re-check CI. Do not report
  the goal as complete while CI is red, pending indefinitely, or unknown.

Final response must include:
- commits landed
- what changed
- subagent review summary
- exact tests/e2e run
- Linux VM/pod e2e result
- browser e2e result
- GitHub CI result
- any residual risks or intentionally deferred work
- worktree/branch cleanup status
```
