# Agent-sync hardening — validation gaps (what still needs a real Linux node)

> **Status: 2026-06-21.** The agent-sync hardening round (H8 large-file streaming,
> H10 atomic commit-group, ACL, R2/R3 VM-per-tenant) is **built, merged, and validated
> as far as macOS allows.** This note records what is proven vs. what still needs a
> real Linux node / k8s cluster, and exactly where + how to close each gap. Each open
> gap has a tracking issue. Companion: [`sync-hardening-plan.md`](./sync-hardening-plan.md).

## Where the code lives
- **Atrium** (`master`): H10 ledger commit-group (#52), path-prefix ACL (#53), H8
  streaming `capture-stream` endpoint (#56 + timeout hotfix #57). All merged, CI green.
- **Centaur** (`gbasin/centaur` → `fork/gb/api-rs-artifact-capture` @ `0a6004a`): the
  `centaur-node-sync` crate (H8 node streaming, H10 `manifest.rs` hydrate, R2/R3 Helm
  manifests), folded in + merged with the upstream harness-resume work. 62 crate tests.

## ✅ Validated (on macOS / in CI)
| Area | How it was validated |
|---|---|
| H10 ledger commit-group | server suite green (atomic all-or-nothing, idempotent by `group_id`, OCC, deadlock-safe lock order) |
| Path-prefix ACL | server suite green (private `scratch/` → 404, internal routes unrestricted) |
| H8 server endpoint | server suite green **+ live against real MinIO**: a 30 MiB (>25 MiB) payload → multipart upload → server-side copy `staging→cas/<sha>` → download = **bytes + sha256 identical** (the part FakeStorage mocks) |
| node-sync crate | 62 unit tests, `clippy -D warnings`, `fmt`; **full `cargo check --workspace`** passes (integrates with every other api-rs crate) |
| R2/R3 manifests | `helm template` renders clean (per-tenant DaemonSet + RuntimeClass + tenant RBAC), both gated-off and per-tenant-on |

## ❌ Not validated — needs a real Linux node / cluster
The daemon bin is `cfg(target_os = "linux")` (openat2, overlayfs xattrs, `/proc` FD
probe, write-through-`merged`) and the multi-tenant infra needs a hypervisor-capable
cluster — none of which exists on Docker Desktop / macOS.

| Gap | Why not on macOS | Where / how to validate | Artifacts | Issue |
|---|---|---|---|---|
| **Pod-native DaemonSet e2e + mountPropagation linchpin + Linux CI** | privileged overlay mount propagation (`Bidirectional`↔`HostToContainer`) + openat2 (Linux 5.6+) have no macOS equivalent | real k8s cluster, or **kind on a GHA ubuntu-latest** runner; run the daemon as the actual pod | `crates/centaur-node-sync/ci/build-and-load.sh`, `ci/pod-native-e2e.sh`, `ci/overlay-validation.sh` | [#62](https://github.com/gbasin/atrium/issues/62) |
| **H8 large-file node↔server wire (live)** | the daemon (sender) is Linux-only; only the server+MinIO half is proven | Linux daemon writes a **>25 MiB** overlay file → streams to `/artifacts/capture-stream` → asserts it lands + serves back | extend `surface/server/scripts/distributed-daemon-e2e.sh` (large-file case) | [#63](https://github.com/gbasin/atrium/issues/63) |
| **H10 commit-group producer + two-daemon convergence** | needs the Linux daemon **and** a not-yet-built outbound producer (node captures file-by-file today; `group_id` plumbing is consume-side only) | wire the outbound commit-group POST, then two-daemon atomic-apply convergence e2e | `manifest.rs` (consume side ready); two-daemon harness | [#64](https://github.com/gbasin/atrium/issues/64) |
| **R2 VM-per-tenant + microVM runtimeClass** | per-tenant DaemonSets + Kata/Firecracker need a CRI handler on the node | real multi-node cluster with a Kata/Firecracker `RuntimeClass` handler | `contrib/chart/templates/node-sync-{daemonset-per-tenant,tenant-rbac,microvm-runtimeclass}.yaml`, `values-per-tenant.example.yaml` | [#65](https://github.com/gbasin/atrium/issues/65) |

## Also pending (separate, deliberate)
- **Integration deploy-merge** (`fork/gb/api-rs-artifact-capture` → `atrium/integration`):
  the divergent-`ci.yml` resolution (keep upstream's `rust-api` steps **and** the
  `node-sync-overlay` job). Best done *after* the pod-native pass above, by one owner —
  it has historically been clobbered when rushed. Not a coding gap; a careful merge step.

## Recommended order
1. **#62** (pod-native harness on Linux/kind) — unblocks the rest.
2. **#63** + **#64** (H8 + H10 live e2es) — both ride on #62's daemon-as-pod harness.
3. **#65** (R2 multi-tenant) — independent; needs a hypervisor-capable cluster.
4. Then the integration deploy-merge.
