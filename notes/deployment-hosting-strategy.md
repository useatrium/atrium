# Atrium — Deployment, Hosting & Business-Model Strategy

> Status: exploration / decision-input doc (2026-06-22). Grounded in a code-level
> audit of the surface stack, Centaur runtime, and voice path. Captures the
> requirements, the full menu of hosting options, and a recommended shape.
> Decisions are still open — this is the map, not the verdict.

---

## 0. TL;DR

Atrium is not one system to host — it's **three planes** with sharply different
hosting physics. Hosting strategy = host each plane where it's cheapest/safest,
and mix providers freely.

| Plane | What | Hosting physics | Where the money/lock-in is |
|-------|------|-----------------|-----------------------------|
| **A — Collab + data gravity** | Postgres + S3 + Fastify server + Caddy | Light, stateful, **already multi-tenant**. Runs on one small box. | The **moat**: convos, agent chats, artifacts live here. Cheap to host. |
| **B — Voice media** | LiveKit SFU | Needs raw UDP + host networking. Can't be proxied or run serverless. Latency-bound. | Minor cost. Only place edge compute helps. |
| **C — Agent execution** | Centaur (k8s) | Heavy. Needs **real k8s nodes you control** for the privileged + isolated tiers. LLM is external API (no GPU). | The **cost center**. Compute is a commodity pass-through. |

**Recommended shape (a "data-plane / control-plane split"):**

- **Small startups → our managed multi-tenant cloud.** Absorb the ops burden (you
  said you're willing to, for growth) and run it on **bare metal (Hetzner/OVH/Latitude)**
  to protect margin. Multi-tenancy already works in the data model.
- **Enterprise → deploy into their cloud/VPC (BYO) or a dedicated single-tenant
  instance we manage in their region.** This is the *fast* path to enterprise — it
  sidesteps building a SOC-2-grade shared-tenant fortress, because their data never
  leaves their boundary.
- **Business model: do both.** Per-seat (or usage) SaaS on the collab layer for the
  startup tier; license + managed-hosting + support for enterprise. Treat agent
  compute + LLM as **usage pass-through with margin**, never a flat per-seat
  subsidy you eat.
- **Licensing: open-core.** Keep the core open (it's your trust + self-host +
  adoption engine), gate the enterprise muscles (SSO/SCIM, VM-per-tenant isolation,
  multi-tenant admin, managed hosting, SLAs).
- **The durable AI-world bet is Plane A + MCP, not Plane C.** Own the data gravity
  and the integration surface (MCP into the customer's warehouse/tools); let raw
  compute be the commodity it is.

---

## 1. Requirements & constraints (grounded in the code)

### Plane A — Collaboration + data (the "where your stuff lives" layer)

- **Components:** Postgres 16 (system of record), S3/MinIO (blobs), one bundled
  Fastify server (`:3001`, migrations run on boot via a PG advisory lock), Caddy
  (reverse proxy + auto-TLS + serves the web SPA).
- **Already multi-tenant.** Row-scoped isolation via `workspace_id` FK + query-time
  membership checks (`migrations/023_workspace_members.sql`, `surface/server`). **One
  deployment can host many small startups today** — no schema-per-tenant rework needed.
- **State = Postgres + S3 only. No Redis.** Durable surface is small and well-defined.
- **Constraint — client-reachable S3 for user files and offloaded artifact reads.**
  Browser/phone file upload/download uses **presigned URLs**, and offloaded artifacts
  are served with presigned GET redirects. The S3 endpoint must be reachable
  *directly by phones/browsers*, not just the server (`surface/server/src/s3.ts`,
  `S3_ENDPOINT` must be "phone-reachable"). This is separate from node/agent capture
  paths, where Atrium may proxy or stream bytes into the object store to preserve
  ledger semantics.
- **Constraint — WebSocket fan-out is in-process.** Presence/typing/calls live in an
  in-memory hub (`surface/server/src/hub.ts`). Horizontal scaling of the server
  needs **sticky sessions or a Redis/NATS pub-sub bridge** (not built yet). Background
  workers (STT, artifact offload, GC) already use lease-based claims, so *those* scale
  fine. → For v1, a single beefy server instance (or sticky LB) is the pragmatic answer.
- **Backups:** `pg_dump` + MinIO tarball today. Production wants managed-PG-style PITR.

### Plane B — Voice media (LiveKit)

- **Self-hosted LiveKit SFU, Apache 2.0** — no vendor lock-in. Optional at boot (chat
  works without it).
- **Network-special:** host networking + raw **UDP 50000–60000**, **3478/udp TURN**,
  **7881/tcp** fallback, **443 TURN/TLS** (`surface/deploy/livekit.yaml`,
  `docker-compose.prod.yml`). **Cannot sit behind an HTTP reverse proxy. Cannot run on
  Cloud Run / Fargate** — needs a VM/host with public UDP.
- **Only one hard latency target:** `<150 ms` mouth-to-ear. Single-region today.
- **Co-location is loose:** API server and SFU only share the LiveKit API key/secret at
  config time (server mints short-lived JWTs). They can live on different hosts/regions.
- **Push is provider-locked:** APNs (iOS, `.p8` token key) + FCM (Android). Payloads are
  redacted by default (`PUSH_REDACT=1`) — GDPR-friendly, but APNs/FCM are blocked in CN.

### Plane C — Agent execution (Centaur)

- **Requires real Kubernetes with control-plane API access.** k3s is the documented
  floor; Docker-only is dev-only and unisolated; api-rs needs RBAC to create/patch
  pods/sandboxes/networkpolicies, so **serverless k8s (Autopilot/Fargate) is out** for
  the control plane.
- **LLM inference is external API** (Anthropic/OpenAI/Bedrock) via the **iron-proxy
  MITM credential-injecting proxy** — sandboxes hold *placeholder* keys; the proxy
  swaps in real creds on egress. **No in-house GPU.** (The only GPU need is *deferred*
  live-caption STT.)
- **Two privilege tiers:**
  - *Core session pods* — unprivileged (UID 1001, drop ALL caps). Managed node pools OK.
  - *Workspace-sync capture* — a **privileged node DaemonSet** (CAP_SYS_ADMIN, overlayfs,
    `mountPropagation`, openat2, reflink; needs **XFS/btrfs** nodes; **Linux-only**,
    un-POC-able on macOS). **Off by default**, but it's the feature that makes
    agent↔human file sharing work. Requires **real nodes you control**.
- **Strong multi-tenant isolation = VM-per-tenant / microVM (Kata/Firecracker).** Also
  needs nodes you control. Off by default; single-tenant deploys skip it.
- **Network model:** egress-only, **zero inbound to sandboxes**. Current captured
  artifacts are staged in Centaur, then Atrium fetches and offloads them into S3.
  The node-sync/internal capture path can stream `node daemon -> Atrium -> S3`;
  direct-to-S3 presigned PUTs from trusted node/sandbox code are a future
  large-file optimization, not the current baseline.
- **Sizing:** ~2 CPU / 2–4 GB per sandbox; a **warm pool** (default 3) is standing
  capacity; reaper kills idle after 3h / 3-day max. Sandbox image is heavy (full
  toolchains) → node disk + pull bandwidth matter. **LLM egress RTT** is the real
  latency sleeper → put clusters in the model provider's region (US).

### MCP / external data — not built yet

- Only an encrypted `user_provider_credentials` table exists (Codex/Claude OAuth). No
  MCP client/server, no warehouse connectors. **But** the iron-proxy credential
  seam is exactly where warehouse/tool creds *should* be injected later (agent queries
  Snowflake/BigQuery without the secret ever touching the sandbox). This is a strategic
  build, not a missing dependency. See §7.

---

## 2. Hosting options, per plane (mix & match)

### Plane A (collab + data)

| Option | Fit | Notes |
|--------|-----|-------|
| Single box (Docker Compose, exists today) | Startup self-host, dev | Postgres + MinIO + server + Caddy on one VM. Cheapest. |
| Managed Postgres + managed object store + server on VMs | Our cloud, prod | RDS/Cloud SQL/Neon + S3/R2/Wasabi + server on 1–2 instances behind sticky LB. R2/Backblaze = near-zero egress, and **presigned client paths hit S3 directly**, so egress is real money here. |
| Fully managed PaaS (Fly/Render/Railway) | Fastest startup tier | Works for A; **B and C still need real VMs/k8s**, so PaaS only covers part of the stack. |

**Egress note:** because clients pull user uploads and offloaded artifacts through
presigned S3 URLs, object-store egress is a line item. Cloudflare R2 / Backblaze B2
(free/cheap egress) > AWS S3 (expensive egress) for the multi-tenant tier.

### Plane B (voice)

| Option | Fit | Notes |
|--------|-----|-------|
| Self-host LiveKit on a UDP-capable VM | Default | One small public VM per region. Cheap. |
| + regional TURN relays (coturn) | Global users | Only if users are in restrictive networks far from the SFU. |
| LiveKit Cloud | If you want zero voice ops | Trades self-host purity for managed regions. Reintroduces a SaaS dependency. |

Edge compute is **only** worth it here, and only for geo-distributed real-time calls.
Don't over-invest pre-PMF.

### Plane C (agent execution) — the consequential one

| Option | Privileged capture? | Strong isolation? | Cost | Fit |
|--------|--------------------|-------------------|------|-----|
| **Bare metal + k3s (Hetzner/OVH/Latitude)** | ✅ full control | ✅ Kata/Firecracker | **$ (cheapest/core)** | Our multi-tenant startup cloud; cost center lives here |
| **Managed node pools (EKS/GKE/AKS)** | ✅ (real node pools, *not* Autopilot/Fargate) | ✅ with node pools | $$$ (3–5× metal + egress) | Enterprise BYO into *their* cloud account |
| **Serverless k8s (Autopilot/Fargate)** | ❌ | ❌ | $$$$ | **Not viable** for Centaur |
| **On-prem / air-gapped** | ✅ | ✅ | customer's $ | Regulated enterprise; LLM egress must be allowed or Bedrock-in-VPC |

**The cost reality:** Plane C is where spend concentrates, and bare metal is ~3–5×
cheaper per core/GB than hyperscaler compute, with egress that's effectively free vs.
metered. Since LLM is a pass-through API call, your infra margin on the startup tier is
basically "metal cost vs. what you charge for agent-hours." → **Run the startup tier on
bare metal.** Let enterprise run on *their* hyperscaler account (their cost, their
compliance umbrella).

---

## 3. Deployment topologies (the actual "ways to ship it")

Five packagings, mapped to segment:

- **T1 — Single-box self-host** (exists). One VM, Docker Compose, chat-only or +k3s for
  agents. *Audience:* solo devs, tiny startups, evaluators, the open-source on-ramp.
- **T2 — Our managed multi-tenant cloud.** Shared Plane A (one Postgres + one bucket,
  workspace-scoped), shared Plane C cluster with per-sandbox NetworkPolicy isolation
  (microVM per-tenant as you scale up). *Audience:* lots of small startups. *Runs on
  bare metal.* This is the per-seat SaaS product.
- **T3 — Dedicated single-tenant instance (we operate).** Same images, one isolated
  stack per customer, in their chosen region. *Audience:* mid-market / security-conscious
  who want isolation but not to run it themselves. Premium price; clean isolation story
  without the multi-tenant SOC-2 burden.
- **T4 — BYO-cloud / customer VPC (operator + Helm).** Customer runs it in their own
  AWS/GCP/Azure account; we ship the operator, charts, and a license key; optional
  remote management plane. *Audience:* enterprise. **Fastest path to enterprise** — their
  data never leaves their boundary, so most data-residency/compliance objections evaporate.
- **T5 — On-prem / air-gapped.** T4 minus internet, plus in-VPC model access (Bedrock /
  self-hosted). *Audience:* regulated/gov. Highest touch; later.

The same artifacts (server image, Helm charts, Centaur operator) power T1→T5 — you're
changing *who runs it and how it's isolated*, not the code.

---

## 4. The bare-metal vs. hyperscaler vs. compliance question (your Q4, answered)

- **Yes, managed k8s works** — just not the serverless flavors (Autopilot/Fargate) for
  Centaur. Use real node pools.
- **Cheap metal does NOT block enterprise.** Enterprise-ready = SSO/SCIM + audit +
  residency + isolation + SLAs + a SOC 2 report. All achievable on Hetzner. (Plenty of
  SOC-2 companies run on Hetzner/OVH.)
- **The fast enterprise path is T4 (BYO-VPC), not a metal choice.** When Atrium runs
  in the enterprise's own account, *their* cloud's compliance posture covers the data
  layer, and you inherit their region/residency for free. You ship software + an
  operator; they bring the compute and the audit umbrella.
- **So:** bare metal for *your* startup cloud (margin), BYO-hyperscaler for enterprise
  (speed + compliance). You don't have to choose one metal for everyone.
- **What you DO need to build for "enterprise soon":** SSO/SCIM, audit-log export,
  the Helm/operator packaging (T4), and a basic SOC 2 program. None of these are
  blocked by hosting on Hetzner.

---

## 5. Business models

You said: explore **per-seat SaaS (2)** *and* **hybrid/sell-infra (1)**, and you'll
absorb burden for faster growth / a more durable AI-era business. Here's the spread.

| Model | How it bills | Pros | Cons / risk |
|-------|--------------|------|-------------|
| **Per-seat SaaS** (T2) | $/user/mo + agent-usage pass-through | Predictable, easy to sell to startups, classic SaaS multiples | You eat Plane C cost if you flat-rate it; margin squeezed by agent-hours + LLM. **Always meter compute separately.** |
| **Usage-based** | $/agent-hour, $/GB stored, $/MCP query | Aligns price with the real cost driver (compute), scales with value | Less predictable for buyers; needs metering you don't have yet |
| **Sell-the-infra / license** (T3/T4/T5) | Annual license + support + managed-hosting fee | High ACV, durable enterprise revenue, customer eats compute | Higher-touch sales, slower; needs packaging + support muscle |
| **Open-core** (wraps all of the above) | Free core + paid enterprise tier + hosting | Adoption flywheel feeds the paid funnel | Must keep a crisp open/paid line (§6) |

**Recommended blend:** per-seat (+ metered compute) for T2 startups; license + managed
+ support for T3/T4 enterprise; open-core as the umbrella. This literally *is* "both 1
and 2," and it's the standard durable infra-company shape.

**The AI-world durability argument (why this is the resilient bet):**
- **Compute is commoditizing.** LLM inference is an API call; agent-hours are k8s pods.
  Building a business on reselling compute margin is a race to the bottom.
- **The durable assets are (a) data gravity and (b) the integration surface.** You
  already noted the incentive: people keep their convos, agent chats, and *work
  artifacts* in Atrium. That's Plane A — cheap to host, expensive to leave. Add
  **MCP into their warehouse + tools** (§7) and Atrium becomes the *system of
  engagement* over their data, not just a chat app. That's switching-cost that
  survives model churn.
- **Implication:** invest in Plane A retention + MCP breadth; run Plane C as lean as
  possible (bare metal / BYO). Don't subsidize compute to win seats — meter it and
  compete on the workspace, not the GPU.

---

## 6. Open vs. closed (your "I'm not sure what makes sense")

**Recommendation: open-core, leaning generous on the core.** Reasoning:

- Your entire positioning is *"open-source, self-hostable, your code/context/creds stay
  with you."* That's the trust wedge that gets a security-conscious startup to even try
  an agent platform. Closing the core throws away your best distribution and the exact
  thing that makes BYO/self-host credible.
- **What stays open (the core):** chat/sessions/artifacts, single-box + single-tenant
  self-host, the agent-watching UX, the CAS ledger, basic Centaur runtime. This is the
  adoption engine and the self-host story.
- **What's paid/closed (enterprise tier):** SSO/SCIM, multi-tenant admin + RBAC,
  VM-per-tenant / microVM isolation, audit-log export & compliance tooling, managed
  hosting, priority support/SLAs, and the managed MCP/warehouse connectors. These are
  the things enterprises pay for and individuals don't need.
- **License choice:** if you're worried about a hyperscaler reselling your managed
  service, put the *server/control-plane* under a source-available license (BSL/AGPL)
  while keeping clients/SDKs permissive. Decide this *before* major external
  contribution, because relicensing later is painful.
- **Avoid fully-closed:** it kills the self-host trust signal and the community
  on-ramp, for a defensibility you can get more cheaply from open-core + a hosted-only
  enterprise tier.

The fork model (Centaur upstreaming to paradigmxyz) and the existing LICENSE mean some
of this is already in motion — the live decision is really *where to draw the
open/paid line*, not open-vs-closed wholesale.

---

## 7. MCP / data-warehouse — the moat to build

This is currently a gap, but it's the highest-leverage build for the durability thesis.

- **The seam already exists:** iron-proxy does per-host MITM credential injection on
  agent egress. Extend it so an agent can hit the customer's Snowflake/BigQuery/Postgres
  (or any MCP server) with the **real credential injected at the proxy** — never exposed
  in the sandbox. This is a natural extension of the no-creds-in-sandbox model, not a
  new security model.
- **Product shape:** a per-workspace **MCP connector registry** (warehouse, CRM,
  ticketing, internal APIs). Agents and humans query org data *through* Atrium; results
  become artifacts that live in Plane A. Now Atrium is the place where work *and* the
  data to do it converge.
- **Why it's the moat:** combined with artifact/conversation gravity, the integration
  surface is what makes Atrium sticky across model generations. It's also a clean
  enterprise upsell (managed, audited connectors = paid tier).
- **Hosting implication:** MCP egress reinforces the "cluster near the data + near the
  model" placement, and strengthens BYO-VPC (the connectors run where the data already
  is). Build this as a paid enterprise feature with an open core protocol.

---

## 8. Recommended phased rollout

1. **Now / startup tier:** Stand up **T2 on bare metal** (Hetzner/OVH) — multi-tenant
   Plane A (managed-style PG + R2/B2 for cheap egress), k3s Plane C with warm pool +
   per-sandbox NetworkPolicy, LiveKit on a UDP VM. Per-seat + metered agent compute.
   *Gap to close first:* server WebSocket scale (sticky LB now; NATS/Redis bridge later),
   real STT model in the image if voice matters, blob-store egress accounting.
2. **Enterprise on-ramp (parallel, since you want it soon):** Package **T4 (operator +
   Helm + license key)** so an enterprise can deploy into their own VPC. Add SSO/SCIM +
   audit export. This is the fast enterprise path and needs *no* change to your metal
   choice. Offer **T3 (we-managed dedicated)** for those who want isolation without ops.
3. **Isolation hardening:** flip on microVM (Kata/Firecracker) per-tenant for T2 as you
   scale tenants; validate the privileged capture DaemonSet on a real Linux node (still
   un-POC'd on macOS — a known open risk).
4. **Moat:** build the **MCP connector registry** + warehouse credential injection as a
   paid enterprise feature. This is the durability play.
5. **Compliance:** start a SOC 2 program once enterprise pipeline justifies it; T4/T3
   isolation buys you time by reducing the multi-tenant blast radius you must certify.

---

## 9. Open risks / things to validate

- **Privileged capture path is un-validated on real Linux nodes** (macOS can't POC
  mountPropagation/overlayfs/microVM). This gates the workspace-sync feature *and* the
  strong-isolation story — validate on a real cluster before promising either.
- **WebSocket horizontal scale** needs a pub/sub bridge before Plane A can run >1
  server instance without sticky sessions.
- **S3 reachability** must be explicit per topology: browser/phone presigned URLs need
  a public or tailnet HTTPS endpoint; internal node/agent capture can go through
  Atrium unless we deliberately add direct-to-S3 egress. This is easy to get subtly
  wrong (the existing docs already warn about it).
- **Metering** for usage-based / compute-pass-through billing doesn't exist yet; needed
  before you can avoid eating Plane C cost on a flat per-seat price.
- **LLM region coupling:** clusters should sit in the model provider's region; BYO-VPC
  in an odd region pays an LLM-RTT tax. Consider Bedrock-in-region for those cases.
- **Relicensing window:** decide the open/paid line and any source-available license
  *before* broad external contribution.
</content>
</invoke>
