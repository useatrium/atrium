# Dev / Root Sandbox Tier — running Atrium on Atrium

**Status:** exploration / design note — NOT decided, NOT built
**Date:** 2026-06-30
**Question:** Can we use Atrium to develop and run Atrium/Centaur *inside its own sandboxes*? What would it take to give sandboxes more power (root, local services, nested containers), and is it worth doing now?

---

## TL;DR

- **Editing + most TS dev of Atrium inside a sandbox already works** (egress is open, full toolchains baked in). What doesn't: standing up the local stack (`docker compose` / `just up`) — sandboxes have no container runtime.
- The default sandbox is deliberately **runc + non-root + drop-ALL-caps + seccomp + deny-by-default egress**. The lockdown is *in-box privilege*, separate from *isolation*. The occupant is untrusted AI code, so that posture is correct for the product's real job.
- There is **no existing root/dev mode**. securityContext is hardcoded; `runtimeClassName` is orphaned for agent pods; resources are already per-session.
- **Decisive constraint:** artifact-sync (node-sync) is **structurally welded to runc + host-visible overlayfs**. gVisor and Kata *break* capture (FS not host-visible); sysbox breaks it *fixably* (uid-shifting); **runc — including runc+root — keeps it.**
- Therefore the runtime question inverts: the "safer" runtimes are **not drop-ins** — they cost the artifact-sync feature until it's rebuilt.
- **For dogfooding now:** a gated, opt-in `dev` profile that injects a root securityContext on runc (~handful of lines) is the only privilege bump compatible with capture.
- **Rolling out root pods *by default* now: not worth it.** No active consumer; weakens isolation right as the box goes multi-tenant (friendly-user hosting). Build it *gated, off by default* if/when there's a consumer.

---

## 1. What a Centaur sandbox is today

1 conversation = 1 Kubernetes Pod under **k3s/kind → containerd → runc** (no gVisor/Kata; `infra/values.local.yaml:36` sets `sandbox:` with no `runtimeClassName`).

- **Agent container** built at `centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/lib.rs:914-920` — has **no `securityContext` field**; non-root comes solely from the image's `USER 1001`.
- **Hardened securityContext** (the init container etc.) is hardcoded at `.../src/tools.rs:121-137`: `allowPrivilegeEscalation:false`, `capabilities.drop:[ALL]`, `runAsNonRoot:true`, `runAsUser/Group:1001`, `seccomp:RuntimeDefault`, pod `fsGroup:1001`.
- **iron-proxy** sidecar MITMs all egress. Base allowlist is `domains: ["*"]` (`centaur/services/iron-proxy/iron-proxy.yaml:22-25`) — **egress is allow-all**; the per-harness allowlists (`fragment.rs:161,194`) only *scope credential-bearing* OAuth sessions.
- **node-sync** DaemonSet captures the agent's writes from the host overlay (see §4).
- **Image** (`centaur/services/sandbox/Dockerfile`) ships node 24/pnpm/cargo/uv/bun/gh/kubectl/claude-code/codex/agent-browser, `postgresql-client` (line 17, **client only**), and `docker-ce-cli` (line 58, **client only — no daemon**). No Postgres server, no MinIO, no dockerd.
- **Resources:** 4GB/2CPU class (per-session via `SandboxSpec.resources`, `lib.rs:1593-1603`).

---

## 2. The ladder: levels of "working on itself within itself"

| Level | Goal | Status today |
|---|---|---|
| **L0** | Edit + typecheck + unit-test surface/centaur | ✅ works (deps install — egress is `*`; warm dep-cache for known repos) |
| **L1** | Build + headless-QA the web UI | ✅ agent can build + drive `:5173` via in-image headless browser |
| **L2** | Run the full surface stack (server+web+PG+S3) in one sandbox | ⚠️ needs work: PG **server** not in image + can't `apt install` (non-root); MinIO trivial; viewing gap |
| **L3** | Develop + run the Centaur runtime (`just up`) | ❌ needs a container runtime / cluster — drive an *external* cluster instead (sibling, not nested) |
| **L4** | Atrium spawns its own Centaur sandboxes (true recursion) | ❌ needs nested containers → privileged/sysbox/kata |

**Surface specifics:** the web app is **not** a standalone SPA — `surface/web/src/App.tsx:38` calls `api.me()` on first paint; `pnpm dev` runs server+web together (`surface/package.json:11`). The server requires Postgres + S3 to boot (`surface/server/src/config.ts:8,80`), self-migrates on boot (`main.ts:22`). Both `DATABASE_URL` and `S3_*` are overridable.

**Why L2 needs work:** running a self-contained surface inside one sandbox means standing up Postgres + MinIO as **localhost processes**. MinIO is a single static binary (fetch + run as uid 1001 — fine). Postgres normally comes via `apt`, which needs root → blocked today. Options: (a) bake postgres-server into a dev image, (b) fetch a relocatable/`pip install pgserver`-style build at runtime, or (c) run a root/dev profile and `apt install`.

**Viewing gap (independent of all the above):** there is no live-port tunnel — the only inbound hosting is the *static* artifact-app path (`surface/server/src/app-presentations.ts`). The agent can headless-QA `:5173`; a human clicking the live dev server needs a preview-proxy feature.

---

## 3. Privilege: isolation vs in-box power

A container gives **isolation** (can't hurt host/other tenants), which is strong here. It does **not** imply **root**. Centaur runs the agent as a powerless non-root user *on purpose*: the occupant is an LLM running arbitrary, possibly prompt-injected commands, and container-root materially eases host escape. So "do whatever you want inside" is intentionally limited.

What's actually blocked is **system package managers** (`apt`, writing root-owned `/usr`). User-space installs (pnpm/cargo/uv/pip --user/static binaries/build-from-source/servers on ports >1024) all work.

**No existing elevated mode (verified):**
- securityContext fully hardcoded (`tools.rs:121-137`); session-create API takes only `harness_type`/`persona_id`/`metadata`.
- `runtimeClassName` exists (`contrib/chart/values.yaml:196`, CRD) and is wired for the **per-tenant node-sync scanner** (`node-sync-daemonset-per-tenant.yaml:38`, kata example w/ overhead 250m CPU/160Mi) — but the **agent-pod builder never applies it** (`lib.rs:1143-1181`). Flipping `sandbox.runtimeClassName` does nothing for agent sandboxes.
- Upstream `paradigmxyz/centaur` is the same: global securityContext, no per-session privilege (DeepWiki).
- **Precedents that elevated pods are deployable here:** the warm-home helper runs `privileged:true, runAsUser:0, mountPropagation:Bidirectional` (`lib.rs:1206-1343`); an `ensure-writable` init runs as root (`lib.rs:971-990`); node-sync uses `CAP_SYS_ADMIN`.

---

## 4. The decisive constraint: artifact-sync is welded to runc + overlayfs

node-sync captures the agent's file changes by reading the **writable overlay upper directly from the host node**:

- DaemonSet reads `--overlays-root /var/lib/centaur/overlays` (`node-sync-daemonset.yaml:42`); merged mount propagated to the agent as `HostToContainer` (`centaur-sandbox-agent-k8s/src/overlay.rs:424`), `Bidirectional` on the daemon side.
- Classifies entries via overlayfs xattrs `trusted.overlay.{opaque,redirect,metacopy}` (`centaur-node-sync/src/overlay.rs:14-20`, `fs_linux.rs:64-72`) — reading these needs `CAP_SYS_ADMIN`.
- Hardcodes `chown(1001,1001)` on restore (`centaur-node-syncd.rs:1258`).

This assumes the writable layer is a **real overlayfs directory on the host**, readable by a privileged node daemon. Runtime compatibility:

| Runtime | Capture | Why |
|---|---|---|
| **runc (current)** | ✅ | upper is a host dir; daemon reads it directly |
| **runc + root** | ✅ | running as root doesn't move the FS off the host overlay — same plumbing |
| **sysbox** | ⚠️ breaks, *fixably* | upper stays on host, but uid-shifting breaks the hardcoded `chown(1001)`/ownership logic — days–weeks to make uid-aware |
| **gVisor** | ❌ structural | Sentry-managed FS, no host overlayfs, no overlay xattrs → captures nothing (silent) |
| **Kata** | ❌ structural | upper lives inside the guest VM; host has no path to it |

**Implication:** the isolation-upgrade path and the artifact-sync feature collide. Adopting gVisor/Kata isn't just node setup — it requires re-architecting capture (per-sandbox sidecar / in-guest agent: weeks–months), or running those sandboxes with capture disabled (coarser snapshots / git-push only).

---

## 5. Runtime landscape (for completeness)

Decisive axis for *this* deployment isn't isolation strength — it's **needs `/dev/kvm` or not**. OVH Public Cloud VMs don't expose nested virtualization (only OVH bare-metal/Metal does).

- **KVM-free (run on the OVH VPS / single-box k3s):** gVisor (runsc, systrap), sysbox, K8s user namespaces (`hostUsers:false`; beta-on 1.33 → GA 1.36).
- **KVM-gated (need bare-metal / nested-virt):** Kata, Firecracker, Cloud Hypervisor.
- **Edera** (Xen paravirt) claims VM-grade isolation without nested-virt + targets agent sandboxing — young/commercial, verify before betting.

Cross with §4: of the KVM-free options, **only runc keeps artifact-sync working as-is**; gVisor breaks it structurally; sysbox breaks it fixably. So even ignoring hardware, the capture coupling pins us to runc for now.

---

## 6. Options

### A. Dogfood surface (root + local PG/MinIO, capture intact) — runc + root
Inject a securityContext into the agent container (it has none today, `lib.rs:914-920`):
```jsonc
"securityContext": { "runAsUser": 0, "runAsNonRoot": false, "allowPrivilegeEscalation": true }
```
- Hardcoded-for-all: ~3–5 lines. **Gated/clean:** add `profile: Option<SandboxProfile>` to `SandboxSpec` + session API, parameterize `tools.rs:security_context_json()`, apply per-container securityContext in `lib.rs` — ~20–40 lines, persona/profile-gated, off by default.
- Enables `apt` + Postgres/MinIO as root. **Keeps artifact-sync working.**
- Cost: root-in-runc on a shared node = escape risk. Defensible on a single-user box; not as a multi-tenant default.

### B. DinD / recursion (L4) — privileged runc (+ caveats)
Root alone is **not** enough. Additionally needs: `privileged:true` (CAP_SYS_ADMIN, device/cgroup/mount/netns), **install dockerd** (image has client only), a storage driver. **And** put the inner `/var/lib/docker` on a non-captured mount (emptyDir/tmpfs) — otherwise inner image layers pollute the overlay capture. Unsafe + capture-fragile.

### C. Safer isolation (gVisor / sysbox / Kata) — blocked on capture
Requires rebuilding node-sync first (sysbox: uid-aware, days–weeks; gVisor/Kata: new capture path, weeks–months), and Kata additionally needs KVM-capable hardware. Defer until there's a multi-tenant isolation requirement that justifies the capture rework.

---

## 7. Is there a benefit to rolling out root Centaur pods right now?

**As a default: no.**
- No active consumer — the dogfooding use case is exploratory; nothing is blocked on it today.
- It weakens isolation precisely as the box moves to multi-tenant (friendly-user hosting), where root-in-runc on shared nodes raises cross-tenant escape risk.
- Root alone doesn't reach the marquee recursion/DinD goal anyway (needs §6B).
- Root subtly changes capture ownership semantics (agent writes as uid 0 vs the `chown(1001)` restore path) — a behavior change to validate.

**The real, present-day benefit is narrow and on-demand:** beyond dogfooding, a root profile removes the recurring "agent needs a system package (`apt install libfoo-dev`)" papercut for hard SWE tasks. That value is captured by a **gated, off-by-default `dev` profile attached only to blessed sessions** — not a blanket rollout.

**Recommendation:** don't flip pods to root. If/when there's a consumer, land the gated profile (§6A) — it's cheap and zero-risk while unused. Treat sysbox/gVisor (and the capture rework they require) as a separate, later decision driven by multi-tenant isolation needs.

---

## 8. Open questions / next steps

- Build the gated runc `dev` profile (§6A) when a consumer exists; decide persona-gate vs explicit session flag.
- Live-preview/port-exposure feature (to view a running dev server from the browser) — independent of privilege; needed for human-in-the-loop UI dogfooding.
- If recursion (L4) becomes a goal: cost out node-sync decoupling from overlayfs (prereq for sysbox/gVisor) vs. accepting privileged-runc DinD with capture exclusions.
- Bake postgres-server + minio into a dev image variant vs. runtime fetch.

## References

Internal (file:line cited throughout). External landscape: gVisor systrap (no KVM, DinD-capable), sysbox (rootless DinD/kind/k3s, no privileged), Kata/Firecracker/Cloud Hypervisor (require `/dev/kvm`), K8s user namespaces (KEP-127, beta 1.33 / GA 1.36), OVH (no nested virt on Public Cloud). See also memory note `centaur-dev-sandbox-tier-research.md` and `agent-sandboxing.md`.
