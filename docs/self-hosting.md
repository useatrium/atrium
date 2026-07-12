# Self-hosting Atrium

Atrium is built to be run on your own hardware. This is the general guide: why
self-hosting is the point, what the stack is made of, what's required versus
optional, and which install path to take. For a complete, real, step-by-step
bring-up of the full stack on one VPS, see the worked example:
[self-host-ovh.md](self-host-ovh.md).

## Why self-hosting is the point

Everything that flows through Atrium — the message log, every version of every
file, agents' full transcripts, the provider credentials your team connects —
is your organization's **context**: the accumulated working memory of how your
team and its agents get things done. As agents do more of the work, that
context becomes some of the most valuable and most sensitive data an
organization has. Atrium's position is that it should live on hardware you
control, in formats you can walk away with.

That position turns into three design commitments:

1. **You own the data plane.** All durable state lives in two boring stores you
   run yourself: Postgres and an S3-compatible object store. There is no
   proprietary database, no hosted control plane, and nothing you can't
   `pg_dump` and sync out.
2. **You control how agents are deployed around it.** The agent runtime
   (Centaur) runs on your Kubernetes, on the same box or your own cluster —
   next to the data, not in someone else's cloud. Sandboxing policy, network
   egress, which harnesses are available, and how credentials reach a session
   are all deployment configuration in your hands. Connected provider
   credentials are stored encrypted in your database and injected only for the
   sessions that need them.
3. **No proprietary load-bearing dependencies.** Every hard requirement is
   commodity open source: Docker, Postgres, MinIO (or any S3 API), Caddy,
   k3s/Kubernetes, Helm. Hosted conveniences — Cloudflare Tunnel, Apple/Google
   push, transactional email, 1Password — are strictly optional layers that
   degrade gracefully when absent (features disable or fall back to a noop;
   nothing else breaks).

The one genuinely external dependency is the AI model itself. Even there, the
model and harness are swappable per session, requests can be routed through a
credential-injecting proxy you run (so tokens never enter the sandbox), and the
deployment can point at a different model endpoint entirely.

Self-hosting isn't a limited community edition: the production instance the
developers use daily is deployed exactly the way these docs describe. Atrium is
AGPL-3.0-or-later; the vendored Centaur runtime remains Apache-2.0 OR MIT (see
[LICENSE](../LICENSE) and [NOTICE](../NOTICE)).

## What you're running

The stack is three planes. Each can be adopted independently, in this order:

| Plane | What it does | Runs as | Needed for |
|---|---|---|---|
| **Surface** | chat, sessions, artifacts, files — the product and all durable data | Docker Compose: Postgres 16, MinIO, the API server, optional Caddy | everything |
| **Centaur** | the agent runtime: locked-down sandboxes that actually run agents | Kubernetes (single-node k3s is fine) via the Helm chart in `centaur/contrib/chart` | live agent sessions |
| **Voice** | real-time calls | self-hosted LiveKit (+ a TURN certificate) | voice calls only |

Surface without Centaur is a working chat/files platform — agent session
spawning is simply unavailable until Centaur is reachable. Voice is off until
LiveKit is configured; the server reports calls as unconfigured and the UI
carries on.

## Requirements

**Hard requirements** (chat platform): a Linux box or always-on machine with
Docker + Compose. That's it — Postgres and MinIO run as containers in the
bundled compose stack. Add **k3s (or any Kubernetes) + Helm + `just`** when you
want agents, and **model credentials** (each user's own subscription login for
Codex / Claude Code, connected in the UI — or a deployment-level API key) for
those agents to do anything.

**Optional layers**, and what happens without each:

| Layer | Enables | Without it |
|---|---|---|
| Caddy (bundled compose profile) | TLS + serving the web SPA | bring your own reverse proxy |
| LiveKit + TURN cert | voice calls | calls disabled, everything else works |
| Resend (`EMAIL_MODE=resend`) | email-code login delivery | `EMAIL_MODE=log` (default) writes codes to the server log |
| Google OAuth | Google sign-in | email-code / open login |
| APNs / FCM / Web Push (VAPID) | native + web push notifications | push is a noop; in-app notifications still work |
| Cloudflare Tunnel + Access | zero-inbound-port front door with an invite gate | plain Caddy TLS or a private tailnet (below) |
| GitHub App + iron-control | per-user GitHub connections for agents | agents work without per-user GitHub identity |
| iron-proxy | model tokens injected outside the sandbox | per-session env injection of the credential |
| 1Password Connect | managed secret backend for Centaur | plain Kubernetes secrets (`secretManager.backend: env`, the self-host default) |
| Observability stack (`infra/observability`) | Grafana/Prometheus/Loki/Tempo, all self-hosted | logs via `docker compose logs` / `kubectl logs` |
| whisper.cpp + ffmpeg | voice message transcription | `STT_PROVIDER=noop` (default) |

Nothing in the optional column phones home or holds your data; each is a
capability you switch on, sourced from whichever vendor you choose (or not at
all).

## Install paths

### Path 0 — try it on a laptop

The [Quickstart in the root README](../README.md#quickstart): `docker compose
up`, `pnpm dev`, open `localhost:5173`. Dev mode, not a deployment.

### Path 1 — chat platform for a team

The surface stack on one host, via the production compose file. The full guide
is [`surface/deploy/README.md`](../surface/deploy/README.md); the shape is:

1. Build the web SPA (`pnpm --filter @atrium/web build`).
2. Copy `surface/deploy/.env.example` → `.env`, generate secrets, set
   `S3_ENDPOINT` to a URL your users' devices can reach.
3. `docker compose -f docker-compose.prod.yml --profile caddy up -d --build`.

Pick a front door:

- **Private network** (Tailscale or LAN): plain HTTP on the tailnet, no TLS or
  DNS to manage. Scenario A in the surface guide.
- **Public VPS with Caddy auto-TLS**: point DNS at the box, set `SITE_ADDRESS`,
  Caddy provisions certificates. Scenario B in the surface guide.
- **Cloudflare Tunnel + Access**: no inbound ports at all, plus an email
  allowlist in front of the app. Phase 4 of the
  [worked example](self-host-ovh.md).

Whichever you choose: keep `BIND_HOST=127.0.0.1` on anything internet-facing
(only the front door is reachable), keep `AUTH_OPEN=0` unless everyone who can
reach the host is welcome to an account, and back up Postgres and MinIO
together.

### Path 2 — agents (Centaur)

This is the differentiating plane, and the one with the most machinery. What it
involves, architecturally:

- **A Kubernetes cluster** — a single-node k3s install on the same box is the
  proven configuration; anything conformant should work. The Helm chart
  ([`centaur/contrib/chart`](../centaur/contrib/chart)) deploys the control
  plane (api-rs), the sandbox controller, and its own bundled Postgres —
  Centaur keeps nothing permanently; durable data stays in Surface.
- **Images you build yourself** — `just build-one api-rs|sandbox|...` from
  `centaur/`, imported into the cluster's containerd (or pushed through a local
  registry once you want content-aware redeploys).
- **Secrets via plain Kubernetes secrets** — `just bootstrap-secrets` seeds
  them; the self-host default is the `env` backend, no external secret manager.
- **Values layering** — the chart's `values.dev.yaml` plus
  [`infra/values.local.yaml`](../infra/values.local.yaml), plus your own
  overrides (the production box's are
  [`deploy/values.box.yaml`](../deploy/values.box.yaml)).
- **One wire to Surface** — set `CENTAUR_BASE_URL` and `CENTAUR_API_KEY` in the
  surface `.env`, and agent sessions light up.
- **Model credentials** — each user connects their own Codex or Claude Code
  subscription login in the UI (stored encrypted, injected per session), or the
  deployment falls back to a configured API key. For validating the plumbing
  without any credential, [`infra/llm-mock`](../infra/llm-mock) stands in for a
  real model.

Step-by-step, in order of preference:

- **Worked example, Phases 6–7** of [self-host-ovh.md](self-host-ovh.md) —
  k3s + images + secrets + Helm + wiring Surface, with every gotcha we actually
  hit. This is the path that runs in production; it applies to any Linux box,
  not just OVH.
- **Centaur's own docs** ([`centaur/README.md`](../centaur/README.md) and
  `centaur/docs/`) for the runtime in depth, and
  [`centaur/ATRIUM_FORK.md`](../centaur/ATRIUM_FORK.md) for what our fork adds.

Optional hardening once it runs, in the order the worked example re-tightens
them: iron-proxy (tokens never enter the sandbox), deny-by-default
NetworkPolicy, artifact capture via node-sync, and the per-node repo cache.

### Path 3 — optional layers

Each is independent; add what you need:

- **Voice calls** — self-hosted LiveKit with signaling behind your front door
  and TURN/media direct on the host. "Production Voice Calls" in the
  [surface guide](../surface/deploy/README.md) and Phase 5b of the worked
  example.
- **Push notifications** — APNs (iOS), FCM (Android), VAPID (web). Set the
  corresponding env vars; unset means noop.
- **Email login** — `EMAIL_MODE=resend` + `RESEND_API_KEY`, or Google OAuth.
- **GitHub connections** — per-user GitHub identity for agents, via a GitHub
  App you register plus Centaur's iron-control. See "GitHub Connections" in the
  surface guide and [github-connections-ops.md](github-connections-ops.md).
- **Observability** — the self-hosted Grafana/Prometheus/Loki/Tempo stack in
  [`infra/observability`](../infra/observability/README.md), same one used in
  production.

## Operations, updates, and CD

- **Backups**: Postgres and MinIO together — commands in the
  [surface guide](../surface/deploy/README.md#operations). Centaur's bundled
  Postgres holds only transient runtime state, but backing it up is cheap.
- **Updating**: rebuild and recreate — surface is one
  `docker compose up -d --build server`; Centaur is a `just build-one` + Helm
  upgrade. [`deploy/redeploy.sh`](../deploy/redeploy.sh) is the committed
  one-command form: content-aware rebuilds, health-gated rollout, automatic
  rollback. See [`deploy/README.md`](../deploy/README.md).
- **Continuous deployment**: push to a `deploy` branch, a self-hosted runner on
  your box runs `redeploy.sh`. Setup in the
  [worked example](self-host-ovh.md#continuous-deployment-promote--box).
