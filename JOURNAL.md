# Build Journal

Running state log. Newest entries at the bottom. This file exists so any session
(or post-compaction context) can resume exactly where work stopped.

## 2026-06-10 — Phase 0 setup

**Environment:** arm64 Mac (16GB), Docker Desktop 29.2.1 (VM: 10 CPU / 7.7GB),
kubectl v1.34, kind + helm + just installed via brew. No pre-existing k8s cluster.

**Decisions made:**
- Cluster: `kind create cluster --name centaur` (context `kind-centaur`) — the
  documented macOS path in centaur's mac-mini-setup.mdx.
- Secrets: env-mode (`ironProxy.secretSource: env`, `secretManager.backend: env`).
  1Password not available on this machine. Token broker requires a writable
  (1Password) backend → **subscription/brokered auth is OUT** (verified in
  `services/api/api/broker_config.py: _STORE_SOURCES`).
- No LLM API keys exist anywhere on this machine (swept env, zshrc, keychain,
  .env files, LaunchAgents, history). m5p asleep. → **Phase 0 runs the real
  claude-code harness against a deterministic in-cluster Anthropic-API mock**
  (`infra/llm-mock`). Claude Code honors `ANTHROPIC_BASE_URL`. Real-model
  confirmation run deferred until Gary provides ANTHROPIC_API_KEY (then: patch
  `centaur-infra-env` secret, remove ANTHROPIC_BASE_URL extraEnv, `just smoke`).
- Slackbot disabled in our deploy (no Slack tokens; surface replaces it anyway).
- Sandbox extraEnv carries ANTHROPIC_BASE_URL + NO_PROXY (merged, verified in
  `kubernetes.py:_apply_tool_server_extra_env`) + telemetry kill-switches.
- Sandbox pods labeled `centaur.ai/managed: "true"`; default-deny egress → our
  k8s.yaml adds NetworkPolicies for sandbox→mock (and iron-proxy→mock fallback).
- Claude harness settings: `bypassPermissions` (tools auto-execute in sandbox).

**State / how to resume:**
- centaur checkout: `~/Code/centaur` (shallow clone, MIT)
- local secrets: `source ~/Code/atrium/.centaur-local/secrets.env` (gitignored;
  holds SLACKBOT_API_KEY + LOCAL_DEV_API_KEY — LOCAL_DEV_API_KEY is the admin
  key for external API calls)
- k8s secret `centaur-infra-env` created in ns `centaur` + patched with mock
  ANTHROPIC_API_KEY ("sk-ant-mock-key-phase0")
- Images: `cd ~/Code/centaur && JUST_BUILD_SEQUENTIAL=1 just build` (background)
- After build: `kind load docker-image centaur-api:latest centaur-iron-proxy:latest centaur-slackbot:latest centaur-agent:latest --name centaur`
  (slackbot image optional since disabled), build+load `atrium-llm-mock:latest`
  from infra/llm-mock, `kubectl apply -f infra/llm-mock/k8s.yaml`, then deploy:
  `helm dependency update contrib/chart && helm upgrade --install centaur contrib/chart -n centaur --create-namespace -f contrib/chart/values.dev.yaml -f ~/Code/atrium/infra/values.local.yaml`
- Probe suite: `python3 phase0/probe.py` (port-forwards API itself; see --help)

**Account-impact notes for Gary:** none so far. Considered and rejected using
~/.codex/auth.json refresh token for Codex access_token mode (broker would
rotate it and likely break local `codex` login; also broker needs 1Password).
Nothing touched your Claude/Codex accounts.
