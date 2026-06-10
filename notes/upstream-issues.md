# Draft upstream issues for paradigmxyz/centaur (NOT yet filed — Gary's call)

Found while building Atrium's Phase 0 on Centaur (kind cluster, env-mode
secrets, mock LLM at a cluster-internal HTTPS endpoint). Each is write-up-ready.

## 1. Per-sandbox proxy egress allows only TCP/443 to arbitrary hosts — undocumented

The per-sandbox NetworkPolicy allows `to: any` only on port 443 (plus API:8000,
PG:5432). Any deployment pointing a harness at a self-hosted LLM endpoint on a
nonstandard port (vLLM :8000, Ollama :11434, etc.) silently times out. Docs
don't mention it; a values knob (e.g. `sandbox.extraEgressPorts`) or at least a
docs note would save people hours. Repro + suggested patch sketch available.

## 2. No supported way to add upstream CAs to iron-proxy trust

iron-proxy verifies upstream TLS against system roots only
(`x509: certificate signed by unknown authority`). Internal LLM gateways /
mirrors with private CAs cannot be reached through the designed CONNECT/MITM
path. We worked around it with a derived image appending our CA to the bundle
(infra/iron-proxy-trust/). Suggest: `ironProxy.extraUpstreamCAs` chart value
mounting into the trust store, or honor SSL_CERT_FILE.

## 3. Token broker requires a writable 1Password backend — blocks subscription auth for env-mode deployments

`broker_config._STORE_SOURCES` only supports 1Password variants because the
broker rewrites the refresh-token blob in place. An opt-in `env` read +
in-memory rotation mode (accepting that a pod restart needs a re-seeded
refresh token) would let small self-hosted deployments use Claude/ChatGPT
subscription auth without standing up 1Password. Risk note: refresh-token
rotation races with any other client of the same account — docs already warn
for Claude; same applies to Codex.

## Bonus observation (maybe issue, maybe docs)

`CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1` hardening makes Claude Code ignore
NO_PROXY entirely, so `sandbox.extraEnv.NO_PROXY` (which the chart merges
deliberately) has no effect for the claude-code harness. Either drop the merged
NO_PROXY suggestion from docs or special-case it.
