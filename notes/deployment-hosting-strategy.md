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
- **Constraint — client-reachable S3 for user files and artifact reads.**
  Browser/phone file upload/download uses **presigned URLs**, and durable CAS
  artifacts are served with presigned GET redirects. The S3 endpoint must be reachable
  *directly by phones/browsers*, not just the server (`surface/server/src/s3.ts`,
  `S3_ENDPOINT` must be "phone-reachable"). This is separate from node/agent capture
  paths, where Atrium may proxy or stream bytes into the object store to preserve
  ledger semantics.
- **Constraint — WebSocket fan-out is in-process.** Presence/typing/calls live in an
  in-memory hub (`surface/server/src/hub.ts`). Horizontal scaling of the server
  needs **sticky sessions or a Redis/NATS pub-sub bridge** (not built yet). Background
  workers (STT, blob-GC, and any future repair jobs) already use lease-based claims,
  so *those* scale fine. → For v1, a single beefy server
  instance (or sticky LB) is the pragmatic answer.
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
- **Network model:** egress-only, **zero inbound to sandboxes**. Captured
  artifacts stream `node daemon/sandbox -> Atrium -> S3/CAS`, and Atrium commits
  the ledger version only after bytes are durable. The older
  Centaur-staging→Atrium-offload path was proven but is removed from the normal path.
  Direct-to-S3 presigned PUTs from trusted node/sandbox code are
  a future large-file optimization.
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

**Egress note:** because clients pull user uploads and durable artifacts through
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

## 2.5 Bandwidth & data-flow economics (co-locate the byte-movers)

The three-plane split only stays cheap if you're disciplined about *where bytes cross
a billed boundary*. Splitting planes by **function** is fine; splitting the **high-volume
byte paths** across providers/regions is what bleeds money and adds lag.

### The byte flows (and which are heavy)

| Flow | Path | Volume | Boundary cost |
|------|------|--------|---------------|
| Artifact capture (ingest) | Centaur pod → node-sync → **Atrium server** → S3 | **Heavy, bursty** (build outputs, edits) | Today *relayed through Atrium* → bytes hit the network twice |
| Artifact read / view / edit | client ↔ Atrium (metadata) + client ↔ S3 (presigned GET) | **Heavy** (the browse-heavy surface UX) | Object-store **egress to the user** |
| Search / list | client → Atrium → Postgres → JSON | Light (text/metadata) | Negligible |
| Watch an agent live | Centaur → Atrium → browser (WS fan-out ×N watchers) | Medium, continuous | Cluster→Atrium, then ×N viewers |
| Inbound sync (hydrate) | S3/Atrium → node → sandbox | Medium | Into the cluster |
| LLM calls | sandbox → iron-proxy → Anthropic/OpenAI | Medium-heavy cumulatively (long contexts + tool output) | Cluster → model provider (**unavoidable**) |
| Voice media | client ↔ LiveKit SFU (UDP) | Heavy during calls | Its own path; never touches Atrium/S3 |

Two flows dominate the bill: **artifact capture** (Atrium relays it, so bytes traverse
the network twice) and **artifact reads** (the surface is browse-heavy, served from the
object store).

### The cost asymmetry you're billed on

- **Hyperscalers:** ingress free, **egress-to-internet expensive** ($0.05–0.09/GB),
  **cross-AZ/cross-region metered** (~$0.01–0.02/GB *each way*).
- **Hetzner/OVH:** egress is **flat / effectively free** (Hetzner ~20 TB/mo included per
  box, then ~€1/TB).
- **Cloudflare R2 / Backblaze B2:** **zero egress.**
- → The *same* workload can swing **10–100×** on cost purely by where bytes leave from.

### Two failure modes to avoid

1. **The relay tax (capture).** With `node → Atrium → S3`, if cluster, Atrium, and the
   bucket sit in three different providers, each captured byte pays egress leaving the
   cluster, gets pushed through Atrium's NIC, *and* may pay again into the bucket. On a
   workspace producing tens of GB/day of artifacts, this is the silent killer.
2. **The serve-egress tax (reads).** Artifacts serve straight from the object store via
   presigned GET. Put that bucket on AWS S3 and one busy workspace reading ~100 GB/day is
   **~$270/mo in read egress alone**; on R2/B2 it's **$0**.

### The governing principle

**Co-locate the byte-movers; let only two things cross a billed boundary.**

- Keep **Centaur cluster + Atrium server + object store + Postgres in the same
  region/provider, ideally one private network.** Then capture ingest, the serve origin,
  and DB queries are all intra-LAN / free. *This is the single most important infra
  decision in this doc.*
- The only flows that *should* cross a boundary are the two you can't avoid: **client
  traffic** (the user is wherever they are) and **LLM egress** (the model lives at the
  provider).
- **Pick a zero/low-egress object store (R2, B2, or Hetzner object storage)** so the
  read-heavy path is cheap *even when the user is far*, and front it with a **CDN** so
  distant reads also *feel* fast.
- Put the cluster **in the model provider's region (US)** for low LLM RTT; lean on
  **prompt caching** to cut repeated-context bytes.

This is the caveat to "mix providers freely" (§0): mix across planes for *latency/feature*
reasons, but never split the heavy internal byte path across billed boundaries.

### How it *feels* (latency), per interaction

- **Search / list:** Atrium↔Postgres RTT only — co-located = snappy; split DB across a
  region = the whole app feels sluggish.
- **Open / preview an artifact:** client→S3 RTT + object size — CDN-fronted bucket = fast
  anywhere; one far region, no CDN = slow for distant users on big files.
- **Edit / save:** client→Atrium + Atrium→S3 + ledger write — co-located second hop is a
  LAN round-trip; split adds cross-region RTT to *every* save.
- **Watch an agent live:** Centaur→Atrium→browser — cluster far from Atrium = laggy
  transcript; same region = real-time.
- **Capture lands:** node→Atrium→S3 — all co-located = sub-second; scattered = each write
  eats cross-region RTT.

### What softens it

- **CAS dedup:** artifacts are content-addressed (sha256) — unchanged/identical bytes
  aren't re-uploaded or re-stored, so capture volume is far below "every file every turn."
  Reflink on the node cuts local copies too.
- **Direct-to-S3 capture (future):** the planned node/sandbox → S3 presigned PUT removes
  the relay tax on large files (Atrium leaves the byte path). Prioritize as capture grows.
- **Prompt caching** cuts LLM egress for repeated context.

### Per topology

- **T2 (our cloud):** trivially solved — cluster + Atrium + bucket + PG in **one
  Hetzner/OVH region/private net**. Internal flows ride included bandwidth; only client +
  LLM egress leave, and Hetzner egress is ~free anyway. This is *why* bare metal wins the
  cost center: the bandwidth problem mostly disappears.
- **T4 (BYO-VPC):** also clean — everything's in the customer's own VPC, so internal flows
  are intra-VPC (watch AWS cross-AZ ~$0.01/GB each way; pin to one AZ or eat it for HA).
  Only client + LLM egress leave *their* account, on *their* bill — another reason BYO is
  the easy enterprise path.
- **The expensive anti-pattern:** Atrium on a PaaS in cloud X, bucket on AWS S3 in cloud
  Y, cluster on bare metal Z. Now every capture and every read crosses a metered boundary.
  Don't.

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

**Recommended blend:** flat platform fee + metered usage for T2 startups (see below);
license + managed + support for T3/T4 enterprise; open-core as the umbrella. This
literally *is* "both 1 and 2," and it's the standard durable infra-company shape.

### Pricing structure (the bill the customer sees) — go simpler than per-seat

**Recommendation: a flat platform fee *per company* + generous included allowances +
metered overage on the real cost drivers (compute + data) — not per-human-seat.** Two
self-serve tiers (~$99 / ~$999/mo) + enterprise-custom.

**Why flat-fee beats per-seat *for Atrium specifically*:**
- **Per-seat taxes your growth loop.** The product bet (README) is that people *watch and
  join each other's sessions*. Charging per human seat penalizes inviting watchers — the
  exact viral/collaboration behavior you want to encourage. And a 5-human startup may run
  50 agents: human seats *undercount both the value and the cost*.
- **The cost is compute + data, not humans.** Flat fee + metered usage makes price track
  cost (the §2.5 "co-locate + meter" principle). You never eat a heavy user on a flat
  per-seat plan; a light user isn't overcharged.
- **Simplicity = land speed.** "$99 for the whole company" is frictionless, expensable,
  self-serve, no seat true-ups. Pure PLG on-ramp. Expansion comes from *usage growth +
  tier-up*, not seat-counting — and agent-hours scale with value delivered, so usage-based
  expansion is well-aligned.

**The guardrails (without these, it backfires):**
- **Bake generous included allowances into each tier** so the *median* customer never
  sees a usage bill — that's what keeps the "simple" promise. Only genuinely heavy users
  meter into overage.
- **Offer BYO-LLM-key.** You already have the mechanism (iron-proxy credential injection,
  §1/§7). Letting customers attach their own Anthropic/OpenAI key moves the largest, most
  volatile cost (LLM tokens) *off your books entirely* — then your "compute" meter is just
  *your* infra (agent-hours), which is cheap+predictable on bare metal. This is the single
  biggest bill-shock and margin de-risk.
- **Spend caps + budgets + alerts** — don't reintroduce the anxiety the simple price
  removed.
- **Gate the tier by value + enterprise features, not arbitrary limits.** $99 = self-serve
  startup (multi-tenant cloud, community support, modest allowance); $999 = growing team
  (SSO/RBAC, bigger allowance, priority support); enterprise = custom (T3/T4 license /
  BYO-VPC). Consider a **free tier** (one workspace, capped usage) to pull the open-source
  crowd onto hosted.

**Maps cleanly to topologies:** flat-fee + metering is the **T2** bill. For **T4/T5
(BYO-VPC / self-host)** the customer already pays their own compute+data *in their own
account*, so you charge a **platform license** (flat annual or capacity-based) + support —
you don't (and often can't) meter their usage. So: *meter the SaaS tier, license the
self-host tier.* Both coexist.

**Dependency / caveat:** metered overage needs **usage metering + a billing engine**
(Stripe metered, or Orb / Metronome / Lago) — flagged in §9 as not-built. Ship the flat
tiers first (easy); add metering once you have unit-economics data to size allowances. The
exact $99/$999 numbers and allowance sizes are a **hypothesis to validate against real
cost-per-workspace**, not a pre-data commitment.

#### SETTLED: BYOK for LLMs — and what that changes

LLM is **always the customer's own key** (injected via iron-proxy; never enters the
sandbox). That means LLM cost/risk is permanently off our books — and it reframes the
whole business:

- **We are a platform/SaaS, not a compute reseller.** Our COGS per workspace collapses to
  cheap infra (~$0.02–0.05/agent-hr compute, cents of storage, free egress on bare metal).
  The *binding* cost is **fixed** — the standing fleet + the ops/support/on-call team —
  not per-workspace variable cost. So the model is fixed-cost-coverage + CAC payback, and
  per-customer gross margin is near-100% past breakeven. **Watch support-cost-per-customer,
  not infra.**
- **The two cost-aligned usage meters are STORAGE + COMPUTE (Centaur/k8s) — meter both.**
  These are literally our only COGS once LLM is BYOK, so usage-pricing them is structurally
  margin-safe (you can never lose money on a heavy user) and fits the "sell the infra"
  identity. Earlier "don't meter compute" was wrong — it assumed cost-pass-through. With a
  normal cloud markup (~5–10× over the ~$0.05/agent-hr floor → ~$0.25–0.50/agent-hr), metered
  agent-hours are *real* revenue: a heavy 1,000-hr/mo workspace pays $300–500/mo in compute
  alone. **Unit = wall-clock sandbox-hours** (a session's sandbox lifetime — the simplest,
  most defensible unit given idle-wait + overcommit), naturally **bounded by the existing
  reaper** (idle 3h / 3-day max), which also caps runaway bills.
- **But wrap usage in a base envelope, don't bill from dollar-zero.** Pure usage-from-zero
  on compute reintroduces the two things to avoid: **bill-shock** (an overnight run spikes
  the invoice — small startups hate this) and a **tax on the behavior you want** (every
  agent-hour costing money makes teams ration agents, the opposite of the engagement/lock-in
  you're after). So: a flat base fee that **includes a generous compute + storage envelope**
  (the median Light/Active workspace never sees a usage line), then **metered overage** above
  it, plus budgets/caps/alerts. This is the standard modern infra-SaaS shape (Vercel /
  Supabase / Neon / Render). Storage is the cleaner of the two meters — it grows monotonically,
  *is* the lock-in, and metering it doesn't discourage anything you want.
- **Layer value capture on top of cost-aligned usage:** (1) **governance** (SSO/RBAC/audit/
  isolation) = the enterprise feature gate, highest-margin and most defensible, usage-independent;
  (2) **MCP connectors / integrations** (the moat); (3) the **LLM-spend-governance add-on**
  below. **Seats are optional and now a pure GTM choice** — the only reason to avoid per-seat
  (eating compute) is gone; if used, keep agents and read-only watchers/guests free so the
  collaboration loop isn't taxed. Usage (storage+compute) protects margin; governance +
  integrations capture the value that compute cost-plus under-prices.
- **Capture the LLM *value* axis without the LLM cost:** since we proxy the customer's key,
  offer **LLM spend governance/observability** as a paid add-on — per-team token visibility,
  budgets/caps, model routing, policy (FinOps for agent spend, à la an AI gateway). Real
  value on the biggest spend line, zero token cost to us.
- **Reinforces self-host + enterprise.** In T4 (BYO-VPC) the customer already brings infra
  *and* LLM key — so we charge software license + support only. With BYOK, both T2 and T4
  are clean software/support-margin businesses with no LLM exposure either way.

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

---

## 10. T2 unit economics (Hetzner bare-metal, mid-2026 prices)

A concrete cost model for the managed multi-tenant tier, built from confirmed pricing
(observed 2026-06-22). **The punchline: infra is almost free relative to the price; the
entire economic question is LLM token cost.** That's *why* the §5 structure (flat fee +
BYO-key + metered overage) is correct.

### Confirmed input prices

- **Compute (the cost center).** ⚠️ **Hetzner ran a 2.5–4× price hike on 2026-06-15** —
  the old "~€119/mo AX102" boxes are no longer orderable. Current right-sized box:
  **AX162-2 — EPYC 9454P, 48 physical cores / 96 threads, 256 GB DDR5, 2× 1.92 TB NVMe,
  €842.30/mo (~$910) + €419 setup**. The **AX162-1** (128 GB) is €612/mo. **Dedicated
  egress is unlimited and free on the default 1 Gbit/s port** — the decisive advantage.
  (Hetzner *Cloud* CCX is ~2× pricier per physical core and meters egress at €1/TB after
  20–60 TB; use dedicated.) OVH Advance/Scale is comparable, unmetered but 500 Mbps
  floor. Post-hike ratio: **~$19/physical-core-mo, ~$3.5/GB-RAM-mo** on Hetzner dedicated
  — still ~6–8× cheaper than a hyperscaler VM (~$58/vCPU-mo), and Hetzner free egress vs
  AWS ~$0.05–0.09/GB is a **50–90× egress gap**.
- **Object store.** R2 $15/TB-mo (free egress) or B2 $6.95/TB-mo (free egress ≤3× stored).
  Per-workspace artifact storage is single-digit GB after CAS dedup → cents/mo.
- **Postgres.** Neon ~$80/mo always-on (or <$20 scale-to-zero) / RDS ~$128/mo Single-AZ —
  but in T2 this is *one shared cluster across all tenants*, so per-workspace it's cents.
- **LLM (Anthropic).** Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 per 1M tokens.
  Prompt-cache read ≈ 0.1× input; write 1.25–2×.

### The packing math (agent-hours per box)

Agent sandboxes are **~2 vCPU / 4 GB and mostly idle** — each turn is seconds of local
work then 10s–minutes blocked on the LLM round-trip. So CPU is heavily overcommittable
(3×+); RAM is the binding constraint. On an AX162-2 (256 GB): ~**64 concurrent sandboxes**
at 4 GB (≈128 at 2 GB). Fully packed 24/7 that's ~46K sandbox-hours/mo → **$0.02/agent-hour**;
at a realistic ~40% average utilization, **≈$0.05/agent-hour of pure infra cost**.

Because sessions are short-lived (reaper kills idle at 3h, 3-day max) and most workspaces
have **zero** active sandboxes at any moment, one ~$910/mo box serves a *lot* of small
startups. Sketch: 200 small startups, ~20% with an active session at any time, ~0.5
concurrent sandbox each → ~20 concurrent sandboxes → fits on **one box** → **~$4.50/
workspace/mo infra**. The shared warm pool (a handful of pre-warmed pods) and shared
PG/server overhead add a few dollars more.

### Cost per workspace per month — three profiles

| Profile | Agent-hrs/mo | Infra (compute+storage+overhead) | LLM if **BYO-key** | LLM if **pass-through** (Opus-heavy) |
|---|---|---|---|---|
| **Light** (5 ppl, ~20 hrs) | 20 | ~$6 | **$0 to us** | ~$40–120 |
| **Active** (15 ppl, ~200 hrs) | 200 | ~$20 | **$0 to us** | ~$400–1,200 |
| **Heavy** (~1,000 hrs) | 1,000 | ~$60 | **$0 to us** | ~$2,000–7,000 |

LLM is **$1–7/agent-hour** (Opus, continuous, with caching) — **20–140× the ~$0.05/agent-hour
infra cost**. That single ratio is the whole pricing argument.

### What it means for the $99 / $999 tiers

- **With BYO-LLM-key, $99/company is margin-positive even for an *active* team** (~$20
  cost → ~80% gross margin), and infra only bites at very heavy agent-hour volume — exactly
  where the $999 tier or metered overage kicks in. The platform fee comfortably covers
  infra + overhead; you're effectively selling the *workspace*, not the compute.
- **Without BYO-key (you pass LLM through), you MUST meter it** — a flat $99 with unlimited
  Opus would be underwater on a single power user within days. So: bake an included
  agent-hour / token allowance into each tier sized to the *median* user (Light/Active sit
  inside it), meter overage, and offer BYO-key to make the variable cost vanish.
- **Sizing the allowance:** at ~$0.05/agent-hour infra + a chosen LLM markup, a $99 tier
  can include generously on infra (hundreds of agent-hours) and gate on *LLM spend* (or
  push it to BYO-key). The exact allowance needs the metering you don't have yet — treat
  these numbers as a starting hypothesis, instrument real cost-per-workspace, then set it.

### Caveats / things to verify

- **Hetzner price hike is fresh (7 days old) and verified** — model with NEW prices; the
  cheaper pre-hike figures are not orderable. The `-Ltd` limited tier (~€317/mo AX162-1)
  exists but availability fluctuates.
- **Hetzner Object Storage overage rate** couldn't be pinned to a primary source — prefer
  R2/B2 for the bucket anyway (free egress, no 64 KB min-object penalty, not EU-only).
- **Overcommit ratio is the swing factor** — the $0.02–0.05/agent-hour figure assumes
  agents idle-wait on the LLM (true today). A compute-heavy workload (local builds, test
  suites) lowers packing density and raises infra cost/agent-hour; measure on real traffic.
- **EU-only data residency** on Hetzner — fine for the cost floor, but US/other-region
  startups may want a US box (still cheap; OVH/Latitude have US metal) and clusters should
  sit in the **LLM provider's region** to avoid the RTT tax (§2.5).

---

## 11. Reference tier table (BYOK world — starting hypothesis)

> Numbers are a **starting hypothesis** to validate against real cost-per-workspace once
> metering exists (§9), not a commitment. Design logic: the *included envelope* is sized so
> the **median** workspace never sees a usage line; **overage is margin-safe at any volume**;
> value capture rides **governance + integrations**, not headcount. LLM is always **BYOK**
> (customer's key via iron-proxy — off our books).

| | **Free** | **Team — $99/mo** | **Business — $999/mo** | **Enterprise — custom** |
|---|---|---|---|---|
| Target | OSS / evaluators / solo | small startups | growing / multi-team | regulated / large |
| Members | up to 5 | unlimited¹ | unlimited¹ | unlimited¹ |
| Agents & watchers/guests | free | free | free | free |
| Workspaces | 1 | 1–3 | unlimited | unlimited |
| Included compute (wall-clock **sandbox-hrs/mo**) | 25 | 500 | 5,000 | custom / BYO-infra |
| Included storage | 10 GB | 100 GB | 1 TB | custom |
| Retention | 30 days | keep everything | keep everything | custom + legal hold |
| MCP / warehouse connectors | 1 | 5 | unlimited | unlimited + governed |
| Compute overage | — (hard cap) | ~$0.30 / sandbox-hr | ~$0.25 / sandbox-hr | volume / BYO |
| Storage overage | — (hard cap) | ~$0.05 / GB-mo | ~$0.04 / GB-mo | volume / BYO |
| Budgets / caps / alerts | basic | yes | yes | yes |
| LLM-spend governance (over BYOK key) | view-only | basic budgets | full (caps/routing/policy) | full + audit |
| SSO / SCIM | — | — | SSO | SSO + SCIM |
| RBAC / audit-log export | — | basic roles | yes | yes + retention policy |
| Isolation | shared multi-tenant | shared multi-tenant | shared (microVM opt-in) | VM-per-tenant / BYO-VPC / on-prem |
| Hosting topology (§3) | T2 | T2 | T2 (+ T3 add-on) | T3 / T4 / T5 |
| Support | community | standard | priority | SLA + named contact |

¹ **Members are never metered** — seats are not a pricing lever (§5). You pay for *resources*
(storage/compute) and *capabilities* (governance/integrations), not headcount; agents and
read-only watchers/guests are always free so the collaboration loop isn't taxed.

**Why these envelopes (grounded in §10):**
- A $99 Team's *full* 500 sandbox-hrs cost us ≈ 500 × $0.05 = **$25 compute** + ~$1.50 storage
  + overhead → **~70% gross margin even at full envelope use**; the "Active" 15-person profile
  (~200 hrs) sits well inside it, so the median workspace **never meters**.
- A $999 Business's *full* 5,000 sandbox-hrs ≈ **$250 compute** + ~$15 storage → ~70% margin;
  5,000 hrs/mo ≈ seven agents running continuously, so only genuinely heavy teams approach it.
- Overage is marked up ~5–6× the $0.05 floor → **margin-safe at any volume**; a workspace that
  doubles its compute pays you, it never costs you. The reaper (idle 3h / 3-day max) bounds
  runaway sandbox-hours automatically.
- Free tier (25 hrs / 10 GB) costs us **~$1.50/mo** — a pure funnel + data-gravity hook.

**What carries expansion (NDR):** storage growing under "keep everything", crossing compute
envelopes into overage, adding connectors, and upgrading for governance (SSO/RBAC/isolation)
— the *workspace getting more valuable*, never headcount being taxed.

**Open knobs to set with real data:** exact envelope sizes + overage unit prices; which tier
gets microVM isolation; whether LLM-spend-governance is bundled into Business or sold as an
add-on; and whether to add an annual-commit discount (typical 15–20%) for Business/Enterprise.
</content>
</invoke>
