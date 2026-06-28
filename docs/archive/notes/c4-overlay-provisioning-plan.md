# C4 overlay-capture: runtime provisioning build + validation plan

> **Status: 2026-06-25. IMPLEMENTED IN THE ATRIUM FORK.** `provision-overlay`
> exists as a Rust binary in the `centaur-node-sync` image, the sandbox controller
> renders the manifest-writer/readiness overlay path, the chart has node-sync and
> overlay provisioning enabled for the Atrium fork, and the pod-native e2e runs in
> CI. Keep the older phase plan below as historical build context.
>
> **Original status: 2026-06-22.** Decision recorded after a four-agent investigation pass.
> Scope: **fixture-first, then production**. Validation venue: **GHA ubuntu-latest + kind**.
> Companion docs: [`sync-validation-gaps.md`](./sync-validation-gaps.md),
> [`cas-ledger-build-plan.md`](./cas-ledger-build-plan.md) (TRACK C4 + §10.7b),
> [`agent-data-architecture.md`] memory.
>
> ## SHIPPED (gbasin/centaur `main`, 2026-06-22)
> Landed as 4 reviewed, CI-green PRs (squash, no branch protection on the fork):
> - **#1 Phase 1** — `provision-overlay` (fixture) + pod-native e2e; **the mountPropagation
>   linchpin is validated in kind-on-GHA** (init `Bidirectional` → node → agent
>   `HostToContainer`; daemon captured 2 upserts + 1 delete). The hard, never-before-validated part.
> - **#4 Phase 2A** — multi-session daemon fan-out (`--overlays-root`) + sidecar manifest
>   (`<overlays-root>/.sessions/<session>.json`); per-session state/error isolation + GC; production
>   `provision-overlay` (writes manifest, chowns upper to `--agent-uid`). Linux build + multi-session
>   e2e green.
> - **#5 Phase 2B** — gated privileged `overlay-setup` init wired into `build_agent_sandbox`
>   (+ `overlay.rs`, `AgentSandboxConfig.overlay`, `--sandbox-overlay-provisioning` flag /
>   `nodeSync.overlayProvisioning.enabled` chart value). Default OFF (byte-identical render unless
>   opted in); 81 crate tests.
> - **#6 Phase 4** — dedicated GitHub-hosted `node-sync image` workflow builds + pushes
>   `ghcr.io/<repo>/centaur-node-sync:latest` (Depot pipeline doesn't run on the fork). No creds.
>
> **A cluster can now run C4** via `nodeSync.enabled=true` + `nodeSync.overlayProvisioning.enabled=true`.
>
> ### Remaining platform work:
> - **Real external prod cutover** is an ops validation, not a missing code path.
> - **Phase 3+ scale work** remains: large-file live wire, commit-group outbound
>   producer, multi-node/per-tenant isolation, and arm64 image coverage where needed.

## 0. The correction this plan exists to fix

C4 ("overlay-upper node-scan") is the decided permanent capture mechanism. This
section records the historical problem statement from before runtime overlay
provisioning was implemented.

| Piece | State | Evidence |
|---|---|---|
| node-sync **scanner** daemon (capture/adopt/manifest) | ✅ built, 62 crate tests | `centaur-node-sync/src/bin/centaur-node-syncd.rs` |
| syscall proofs (openat2/whiteout/xattr) | ✅ scripted | `centaur-node-sync/ci/overlay-validation.sh` |
| Helm DaemonSet (scanner) | ✅ built; enabled in Atrium fork values/defaults | `contrib/chart/templates/node-sync-daemonset.yaml` |
| mountPropagation kernel mechanism | ✅ POC-confirmed (9/9, privileged Linux container) | memory `agent-data-architecture.md` |
| **`provision-overlay` binary** (mounts the per-session overlay) | ✅ built | `centaur-node-sync/src/bin/provision-overlay.rs`; image copies `/usr/local/bin/provision-overlay` |
| **sandbox controller wiring** (render init container + mounts per pod) | ✅ built | `centaur-sandbox-agent-k8s` overlay config + manifest writer/readiness wait |
| **teardown unmount** (orphan-mount cleanup) | ⚠️ operational cleanup path still worth auditing | node-sync remounts idempotently; local smoke showed repeated "already mounted" messages |
| pod-native e2e harness | ✅ built | `centaur-node-sync/ci/pod-native-e2e.sh` |

**Current consequence:** this plan is no longer blocking C4. Use it to understand
why the current implementation exists; do not read the old "absent" language as
current state.

## 1. Why not validate on this Mac

- Kernel is fine: Docker Desktop VM = `6.12.76-linuxkit` (openat2 ≥5.6 ✓), overlayfs present.
- **Blocker = nested overlay**: the kind node `centaur-control-plane` rootfs is *itself*
  overlayfs (`overlay on /`), so a hostPath overlay `upper` can't be created there without a
  tmpfs/ext4-loopback workaround. This is exactly why #62 says "Cannot run on Docker Desktop".
- Local kind can be a **fast inner loop** (with the tmpfs workaround) but **sign-off is
  GHA-ubuntu+kind** (ext4-backed, faithful). Neither validates multi-node / per-tenant
  isolation (#65 — separate, needs a hypervisor-capable cluster).

## 2. Design decisions (locked)

- **D1 scope:** fixture-first → then production. Prove the mount→capture round-trip as a real
  pod before changing the live runtime.
- **D2 venue:** GHA ubuntu-latest + kind, wired as a (initially non-required) CI job.
- **D3 gating:** production provisioning is **flag-gated, default OFF** — proposed
  `nodeSync.overlayProvisioning.enabled` (Helm) → `OVERLAY_PROVISIONING_ENABLED` env to api-rs,
  mirroring the already-gated `nodeSync.enabled`. The in-agent poll remains the default.
- **D4 lower dir:** repo mounted **RO as the lower** (not cloned into a writable dir) so the
  `upper` doesn't bloat to repo size (C4 commitment #1).
- **D5 upper persistence:** session-keyed upper on a node hostPath
  (`/var/lib/centaur/overlays/<session>/{upper,work}`), survives pod delete (also upgrades
  resume from re-clone → state-restored).

## 3. Execution phases (work-breakdown for agent-fanout)

Each lane is a codex worker in an **isolated worktree**. Claude orchestrates: plan → spawn →
review every diff firsthand → merge. Rust lands on **centaur fork `main`**; CI/notes on
**atrium `master`**. All PRs squash through branch protection.

### Phase 1 — Fixture: prove the mechanism on Linux (closes #62)
- **L1 (centaur):** write a minimal `provision-overlay` entrypoint (script or thin Rust bin)
  that mounts the overlay (RO lower = a seed dir, upper/work = node hostPath, merged) for a
  `--session <id>`, sets propagation, idempotent, exits. Fixture-grade is acceptable here.
- **L2 (centaur):** fill `ci/pod-native-e2e.sh` step `[4/6]`: apply the provisioning (init
  container from the example), spawn a throwaway agent pod sharing the merged mount via
  `HostToContainer`, write a file into it; assert the daemon logs `capture: … upserts` and
  `inbound: … adopted`.
- **L3 (atrium):** GHA workflow `node-sync-overlay-e2e` on `ubuntu-latest` — `kind create`,
  `ci/build-and-load.sh`, `helm … --set nodeSync.enabled=true`, run `ci/pod-native-e2e.sh`.
  Start as non-required; flip to required once green.
- **Gate:** CI green on GHA → #62 closeable.

### Phase 2 — Production provisioning (the real finish line)
- **P1 (centaur):** real `provision-overlay` Rust binary in `centaur-node-sync/src/bin/` —
  `mount(2)` overlayfs (lower RO repo + hydrated artifacts, session-keyed upper/work, merged),
  correct propagation, idempotent re-attach on resume, structured errors. Add to the image
  `Dockerfile` (`/usr/local/bin/provision-overlay`).
- **P2 (centaur):** wire into `centaur-sandbox-agent-k8s/src/lib.rs::build_agent_sandbox()` —
  behind `D3` flag: render the privileged init container + hostPath `upper`/`merged` volumes +
  `mountPropagation: HostToContainer` on the agent workspace + `NODE_SYNC_UPPER` env. Repo as
  RO lower (D4).
- **P3 (centaur):** teardown unmount — controller delete-path (or a small reaper) unmounts the
  persisted overlay so nodes don't accumulate orphan mounts.
- **P4 (centaur):** chart wiring — `nodeSync.overlayProvisioning.enabled` value + plumb the env
  through `apirs.yaml`.
- **Gate:** real session spawn (flag on) → agent writes a file → captured → ledger version →
  offloaded to MinIO → served back. Validated on the GHA harness extended from Phase 1.

### Phase 3 — Ride-along live validations (now unblocked)
- **#63** H8 large-file: agent writes >25 MiB into the upper → daemon streams to
  `/artifacts/capture-stream` → lands + serves identical. Extend `distributed-daemon-e2e.sh`.
- **#64** H10 commit-group **producer** (not-yet-built outbound side) + two-daemon convergence.

### Phase 4 — Prod build + cutover prep
- Build the production centaur image including `provision-overlay`; push to the deploy registry
  (TBD — discover from chart/CI; **ask if creds blocked**).
- Atrium prod compose already enables offload/GC (`docker-compose.prod.yml`); confirm the
  ledger end-to-end against the prod-built producer.
- **Cutover (later, deliberate):** disable the in-agent poll when C4 is on; verify parity
  (secret-scan + MIME filtering the poll does today). #65 multi-tenant stays for a real cluster.

## 4. Issue hygiene
- **File new:** "Implement C4 runtime overlay provisioning (provision-overlay + controller
  wiring + teardown)" — the untracked prerequisite that blocks #62. *(Propose; do not file
  without sign-off.)*
- **Annotate #62:** depends on the new provisioning issue; note the step-4 stub.
- On completion: close #62 (and #63/#64 as their phases land); update `sync-validation-gaps.md`
  (add the provisioning row; move closed gaps to ✅).

## 5. Risks
- Privileged init container + `CAP_SYS_ADMIN` for `mount(2)` and reading `trusted.overlay.*`.
- mountPropagation `Bidirectional` only on privileged containers (agent stays `HostToContainer`).
- Orphan mounts if teardown is missed (P3 is load-bearing).
- GHA kind kernel/openat2 + cgroup nuances; iterate via pushes.
- This is a **runtime change** — every gate stays default-OFF; review every diff before land.
