# BYO subscription credentials in Centaur sandboxes (Codex first)

**Goal.** Let Atrium users run agents on **their own** Codex (ChatGPT Plus/Pro)
— and ideally Claude — subscription inside Centaur sandboxes, instead of Atrium
paying API token costs. Research + design, 2026-06-18.

## TL;DR

1. **The hard infrastructure already exists in Centaur.** iron-proxy (per-sandbox
   MITM sidecar) + `iron-token-broker` + the `BrokeredTokenSecret` type are
   **purpose-built for exactly Codex "Sign in with ChatGPT" and Claude Code OAuth
   subscription tokens.** The token never enters the sandbox. We build no broker
   and no proxy.
2. **The one real gap is multi-tenancy:** the broker vault is *deployment-wide*
   today ("any thread can use any configured credential; per-user/per-channel
   scoping is on the roadmap"). True per-user BYO is a **Centaur contribution**,
   not Atrium code (our drafted upstream issue #3).
3. **ToS:** Codex-via-subscription is gray/tolerated (not blessed); Claude-via-
   subscription is explicitly prohibited and server-side enforced. **Codex first,
   at our own risk; keep an API-key fallback. Do not ship Claude on a sub.**

## How Centaur's credential injection works (verified via DeepWiki on `paradigmxyz/centaur`)

- **iron-proxy** runs as a sidecar in each sandbox pod in **MITM mode**: all
  outbound HTTPS is routed through it; it terminates TLS, inspects, and
  **rewrites the `Authorization` header per request**. The sandbox holds only
  **placeholder values** — never the real key/token.
- **CA trust:** at pod creation Centaur sets `NODE_EXTRA_CA_CERTS`,
  `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO` →
  `/firewall-certs/ca-cert.pem` (iron-proxy's MITM CA). Codex (Node/Rust) and
  Claude Code honor these automatically.
- **Secret types:** `HttpSecret` (static, replace/inject modes), `OAuthTokenSecret`,
  and **`BrokeredTokenSecret`**.
- **`BrokeredTokenSecret`** is documented as being *"for IdPs with strict refresh
  token reuse detection, such as OpenAI Codex and Anthropic Claude Code OAuth."*
  The `iron-token-broker` holds the refresh token, mints short-lived access
  tokens, and **rewrites/rotates the refresh-token blob in place** — a single
  writer, which neutralizes the single-use-refresh-token race *within Centaur*.
  iron-proxy injects the minted access token.
- **Codex ChatGPT mode specifically:** *"For Codex in access_token mode, requests
  are routed to `chatgpt.com`, and iron-proxy injects the `chatgpt-account-id`
  header"* — the ChatGPT account UUID (= the `account_id` field in
  `~/.codex/auth.json`). So it targets the ChatGPT backend, not just
  `api.openai.com`.
- **Spawn-time mapping:** `KubernetesExecutorBackend._ensure_token_broker` renders
  broker YAML from `SecretDef`s into a ConfigMap and patches the broker Deployment;
  `ToolManager` selects harness creds by engine + `CODEX_AUTH_MODE` /
  `CLAUDE_CODE_AUTH_MODE`.

**Source pointers (legacy Python `services/api` — see verify item below):**
`services/api/api/tool_manager.py` (`_INFRA_SECRETS`, `_HARNESS_SECRETS`),
`services/api/api/proxy_config.py` (`render_proxy_yaml`, brokered-token rendering),
`services/api/tests/test_proxy_config.py`
(`test_render_brokered_token_emits_token_broker_source`),
`KubernetesExecutorBackend._ensure_token_broker`.
Atrium-side infra: `infra/llm-mock/k8s.yaml` (egress + iron-proxy ingress),
`infra/iron-proxy-trust/` (CA-append workaround), `notes/upstream-issues.md`
issues #2 (CA trust) and #3 (broker 1Password-only / per-user gap).

## Gaps & open items

1. **Multi-tenancy (the blocker).** Broker vault is deployment-wide; per-user
   scoping is roadmap. Options:
   - **MVP:** one shared subscription as a `BrokeredTokenSecret` for the whole
     deployment. Works now, but it's *Atrium's* sub (not each user's) and strains
     the "ordinary individual usage" assumption with many users on one account.
   - **Per-tenant Centaur scoping** (namespace/deploy per tenant). Heavy.
   - **Per-user scoping in the broker** — the roadmap feature; our drafted issue
     #3 (writable per-user store + `env`/in-memory rotation mode). This is the
     real "make BYO work" task. Centaur contribution.
2. **Writable secret backend.** `BrokeredTokenSecret.refresh_token` names a
   *writable* blob the broker rewrites on each rotation; only 1Password
   (`onepassword` / `onepassword-connect`) supported today. Per-user needs a
   writable per-user store.
3. **POC — confirm the Rust path.** DeepWiki's citations are the **legacy Python
   `services/api`**. Atrium now targets the **Rust `services/api-rs`** (spawn API
   that "does not expose execution lookup yet"). **Confirm `api-rs` wires
   `BrokeredTokenSecret` → iron-proxy** before assuming it's free; the rewrite may
   not have ported it.
4. **Rotation vs. the user's laptop.** Broker is single-writer within Centaur, but
   rotation still races *"with any other client of the same account"* (issue #3).
   → **Capture a separate login lineage for Atrium**; never reuse the laptop's
   `~/.codex/auth.json`.

## Atrium's remaining work (small)

1. **Capture** a per-user Codex refresh token once, via a dedicated Atrium OAuth/
   device-code flow (separate lineage from the laptop).
2. **Store** it in the broker's secret backend, scoped per user (depends on gap #1/#2).
3. **Map** the right `BrokeredTokenSecret` to the sandbox at spawn via
   `CODEX_AUTH_MODE` (depends on gap #3 — `api-rs` support).
4. Keep `OPENAI_API_KEY` (and `ANTHROPIC_API_KEY` for Claude) as the **compliant
   fallback** on the same rails.

## ToS detail

- **Codex / OpenAI:** No sanctioned BYO-plan path. "Sign in with ChatGPT" for 3p
  apps is identity-only (does not grant plan model usage); the BYO-plan request
  `codex#10974` was closed "not planned"; docs steer programmatic/CI use to API
  keys (*"Don't expose Codex execution in untrusted or public environments"*). An
  OpenAI maintainer declined to bless OAuth use in third-party tools
  (`codex#8338`). Tolerated, not permitted → ship at our own risk.
- **Claude / Anthropic:** Explicitly prohibited — *"Anthropic does not permit
  third-party developers to offer Claude.ai login or to route requests through
  Free, Pro, or Max plan credentials on behalf of their users"*
  (code.claude.com/docs/en/legal-and-compliance), with **server-side enforcement**
  (OpenClaw/OpenCode crackdown, ~Apr 2026) and legal letters. Also `claude -p` +
  OAuth was reported to bill API rates rather than the sub (anthropics/claude-code
  #43333 — may have been reverted). → Use API keys / org seats, not the sub.

Related: `notes/upstream-issues.md`, `notes/agent-session-resume-and-storage-plan.md`,
`notes/local-atrium-centaur-runbook.md`.
