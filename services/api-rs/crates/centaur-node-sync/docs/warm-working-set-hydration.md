# Warm working-set hydration (C4 §5B) — design

> 2026-06-22. Builds on the shipped C4 base (PRs #1/#4/#5/#6/#7) + PR #8 (session-scoped
> `/atrium` read-only context mount). Decisions locked: **Option A (daemon owns the
> overlay)**; warm working set = git repos + Atrium artifacts + warm caches; two-tier
> storage; content-keyed caches.

## Goal
The agent's `/workspace` is an overlay whose **read-only lower is a composed "warm
working set"** and whose **upper is the session's edits** (captured by node-sync):
git repos + prior Atrium CAS artifacts + warm caches (`node_modules`, `target/`, …).

## Storage model (two-tier)
The overlay lower is node-local (`/var/lib/centaur/overlays/<session>`), materialized from
a durable remote tier on demand (k8s nodes are ephemeral):
`durable remote (CAS/GitHub) → node-local cache (reflink source) → overlay lower (reflinked RO)`.
- git: GitHub → repo-cache node-local clone (+ clone-on-demand).
- artifacts + warm caches: Atrium CAS (content-addressed) → node-local → lower (`hydrate_lower`).
- warm caches content-keyed (lockfile hash etc.), shared via CAS, tenant-scoped by prefix.

## Roles (Option A — daemon owns the overlay)
- **Agent pod — NO privileged container**:
  1. non-privileged **manifest-writer init** (`provision-overlay --manifest-only`) writes the
     sidecar manifest to the node.
  2. non-privileged **readiness-wait init** — blocks until the daemon's ready marker at the merged path.
  3. agent container — `HostToContainer` workspace at `/workspace`, `workingDir: /workspace`,
     **plus the PR #8 session-scoped `/atrium` read-only mount (preserve it)**.
- **node-sync daemon** (privileged, per node): discover session → compose lower → mount overlay
  (→ merged on node) → write ready marker → capture upper. Unmount + clean on session GC.

## Phases (gated default-off, land incrementally)
- **5B-1 (current):** daemon-owned overlay foundation; agent pod = manifest init + readiness init +
  HostToContainer workspace (+ keep PR #8 /atrium). Lower = repo-from-manifest (5A) for now.
- **5B-2:** per-session multi-repo selection → `/workspace/<repo>/…` from repo-cache (+clone).
- **5B-3:** wire `hydrate_lower` for Atrium-CAS artifacts.
- **5B-4:** warm-cache tier (content-keyed CAS blobs → node-local → reflinked lower; eviction).
