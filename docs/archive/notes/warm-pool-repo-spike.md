# Spike: warm pool for repo-bearing sessions (post-claim overlay rebind)

> **Status: SPIKE (2026-06-28).** De-risks the last piece of "warm the whole lease" — giving
> repo-bearing sessions the warm pool's pod-boot saving (they already get warm deps/git/toolchain).
> Builds on `docs/archive/notes/warm-lease-build-plan.md` §5. **Verdict: GO**
> (pending the POC going green on kind-on-GHA). This is a real Centaur runtime change, not a flag flip.

## The question

The warm pool only serves *generic* sessions — `centaur-session-runtime/src/lib.rs` claim filter:
`warm_harness_matches && warm_persona_matches && environment.is_empty() && resume_thread_id.is_none()
&& session_repos_json.is_none()`. Repo sessions are **excluded**, so they always cold-spawn and pay
full pod schedule + container start. Can a repo session instead **claim a generic warm pod and bind
its repo + cache _post-claim_**, the way build-plan §5 intends ("claim generic, hydrate post-claim via
the overlay daemon, never bake repo/cache into the warm spec")?

## Findings (grounded in code)

**1. A warm pod already has a per-pod workspace slot with a generic overlay mounted.**
The warm spec includes the workspace volume + overlay init containers + dep-cache mount; it just runs
the overlay-manifest-writer with **empty `AGENT_REPOS_JSON`**. So at boot the daemon mounts a generic
(empty-lower) overlay at the pod's slot and the readiness init unblocks. Crucially the slot host path is
`/run/centaur/merged/<sandbox-id>` — **keyed by the pod's own id, NOT the thread/repo.** (Recon initially
read this as "session-scoped → can't rebind"; it's actually per-pod, so rebind = remount *in place*.)

**2. Rebind = remount the overlay at the SAME per-pod slot, swapping the lower.** Not "mount a different
path into the pod" (which Kubernetes forbids — volume mounts/init-containers are fixed at pod creation).
The host path stays the pod's slot; only the overlay *contents* (lower = the claimed repos) change. With
`mountPropagation: HostToContainer`, a mount the daemon makes at that slot propagates into the running
container. The init containers never need to re-run (they only gated initial readiness).

**3. There is a clean post-claim window, and precedent for post-claim mutation.** `claim()` today already
mutates a claimed pod post-claim — it reassigns the iron-proxy principal (`assign_iron_control_proxy_principal`)
and blocks until applied before any stdin is written. The harness only runs when the **first `turn.start`**
arrives (`write_input_lines`), which is *after* `claim()` returns and after `set_runtime_context`. So there
is a well-defined window — after claim, before turn 1 — where the pod is running and attached but idle, in
which to do the rebind and a readiness handshake. The hook slots in right after `set_runtime_context`, before
`ensure_session_pipe` (`centaur-session-runtime/src/lib.rs` ~1376–1405).

**4. The one genuinely-unproven primitive:** does an overlay **re-mount at the slot AFTER the agent container
is already running** propagate into it? The existing `pod-native-e2e` only proves the daemon's mount is seen
when it lands *before* the agent container starts (the readiness init gates startup on it). The spike POC
(`ci/warmpool-rebind-poc.sh`) isolates the post-start, remount-in-place case on a real Linux node.

## POC

`centaur/services/api-rs/crates/centaur-node-sync/ci/warmpool-rebind-poc.sh` (informational CI step on the
kind job): mount a generic overlay at a per-pod slot → start a pod bound to it (HostToContainer), confirm it's
Ready with an empty `/workspace` while the container runs → **post-start, unmount + remount the slot with a
repo lower** → assert the already-running container now sees the repo + that a "first-turn" write lands in the
capturable overlay upper. Green ⇒ the rebind primitive holds. (Can't run on Docker Desktop — needs a real
Linux node; runs on kind-on-GHA like the other overlay e2es.)

## Verdict: GO (scoped)

Feasible and aligned with §5. The remaining build, in order:
1. **Generic-slot warm spec hygiene** — confirm the warm pod boots Ready with an empty generic overlay and is
   safe to remount (it already does; verify the readiness path doesn't re-arm).
2. **Post-claim rebind in `centaur-session-runtime`** — in the post-claim window, write the claimed session's
   manifest for the pod's slot (repos + atrium_session + agent_uid) and signal the daemon to **unmount the
   generic overlay and mount the composed overlay (repo lower + warm-cache lower + upper) at the slot**, then
   a **readiness handshake** (block until remounted) before the first turn. Mirror the iron-proxy "apply +
   wait" barrier already used on claim.
3. **Relax the filter** — drop only `session_repos_json.is_none()` (keep env/persona/resume exclusions;
   personas are moot for Atrium — it doesn't set one).
4. **Identity** — the claimed session's `CENTAUR_THREAD_KEY` / scoped token reach the pod via the existing
   post-claim annotation patch + attach protocol (already happens); confirm the harness picks up the workspace
   on turn 1.
5. **e2e** — promote the POC into a full real-pod test (claim → rebind → first turn runs in the repo).

## Decisions already locked (this turn)

- **Topology:** single-node now, multi-node later → locality is free for v1; don't corner it.
- **Cache locality:** claim any warm pod + cross-node CAS pull on a cold node (no affinity scheduling).
- **Dep-cache reach:** cross-node via the daemon (the warm-cache lower composes into the post-claim overlay).
- **Eligibility:** repos only (personas unused in Atrium).
- **Value:** the prize is the pod-boot seconds (interactive snappiness when @mentioning an agent in a repo
  channel); cache locality is already maxed by Phase 1 on one node. Worth measuring pod-boot in prod to size it.

## Risks / open

- **Unmount-under-a-running-rslave-pod**: the pod briefly sees `/workspace` empty during the swap. Safe because
  the harness is idle pre-turn-1, but the rebind must complete + handshake before stdin. (POC exercises this.)
- **Failure mode**: if the rebind fails, fall back to **releasing the warm pod + cold-spawning** (never serve a
  half-bound pod). Best-effort, like the rest of the warm-cache.
- **Reaper/lease**: a claimed-then-rebound pod follows the normal session lifecycle; no new idle pods (we keep
  the single generic pool — no per-repo idle cost).

## Future (not this work)

Per-repo prebuilt pools (build-plan §7 "Full") pre-pay the *install* second too, at combinatorial idle cost —
defer to hot repos only. At large multi-node scale, **eager cross-node replication** of the hot dep-store set to
every node (Dragonfly/Kraken-style p2p, bounded by disk) makes every node always-warm; content-addressed blobs
let it drop in without touching cache logic. Tracked in gbasin/atrium#141.
