# Per-user credentials — plan (per-user GitHub via iron-control)

**Status:** design, ready to build · **Date:** 2026-06-28 · **First consumer:** per-user GitHub (`gh` + `git`)

## Problem

Today every agent sandbox authenticates to GitHub with a **single, shared, org-global
`GITHUB_TOKEN`**. It's installed and auto-authed in every box (image has `gh`;
`entrypoint.sh` runs `gh auth login --with-token` + writes `.git-credentials` from
`$GITHUB_TOKEN`), but it is the *same* token for every session and every user. There is
no per-user GitHub identity in Atrium. We want agents to act on GitHub **as the user who
owns the session**, and we want to shrink the blast radius of one shared token.

This plan does GitHub first, but it is really the plan for **per-user credentials in
general** — GitHub is just the first cred to ride the mechanism.

## How credentials reach sandboxes today (context)

Three tiers; only the top one is inherently global:

| Tier | Where | Per-user? |
|---|---|---|
| **Infra secrets** | `centaur/services/api-rs/crates/centaur-iron-proxy/src/infra.yaml` (`GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `OPENAI_API_KEY`) | ❌ plain env lookup on the proxy pod, no principal context |
| **Principal-granted StaticSecrets** | iron-control `Grant`s | ✅ value differs per principal (inline `control_plane` value or broker) |
| **Broker credentials** (OAuth refresh) | iron-control `BrokerCredential` | ✅ fully per-principal |

The iron-proxy is a per-sandbox MITM TLS proxy. Sandboxes send a **placeholder**
(`GITHUB_TOKEN=GITHUB_TOKEN`) in the `Authorization` header; the proxy swaps it for the
real secret on the wire, so the real value never lands in the box. iron-control resolves
each principal's secrets at claim time via `effective_config(namespace, principal)`
(`centaur-sandbox-agent-k8s/src/iron_proxy.rs:~202`). GitHub is shared **only** because
it sits on the infra tier.

## Decisions

- **Route B (proxy / per-user principal).** Token never enters the sandbox; the proxy
  swaps a per-user value on the wire. Not env-injection.
- **Cred-owner = `sessions.provider_credential_user_id`** (already a column — "act as this
  user's creds"). Not `spawned_by` / `driver_id`.
- **Principal per user, global namespace:** `atrium-user-<id>` in the `default` namespace.
  (Workspace namespacing deferred — see Open questions.)
- **iron-control is the system of record** for the secret. Atrium stores only
  status/metadata (connected, scopes, last-4). No duplicate secret-at-rest.
- **No-connect fallback = a *minimal* shared default** (e.g. public-repo-read token),
  not today's full org token, and not "no GitHub." Connecting upgrades the principal to
  acting as the user.
- **Identity UX = one front door + one escape hatch**, not three co-equal options:
  - **GitHub App "Connect"** (Phase 1) → short-lived, repo-scoped, revocable installation
    tokens → iron-control `BrokerCredential`. The primary, marketed path.
  - **"Paste a token"** (Phase 0) → accept fine-grained *or* classic transparently → 
    iron-control `StaticSecret`. A single advanced affordance; also unblocks day one.
  - These map 1:1 onto iron-control's two cred types (App→broker, PAT→static).

## Verified facts (don't re-derive)

- **iron-control has a full bearer-auth HTTP write API** — `PUT /api/v1/principals`,
  `PUT /api/v1/static_secrets`, `PUT /api/v1/broker_credentials`, `POST /api/v1/grants`,
  `POST /api/v1/principals/:id/roles` (assign role). Documented in
  `centaur/services/console/docs/API.md`; `centaur-perms` already drives it; the Rust
  `IronControlClient` (`centaur-iron-control/src/client.rs`) has the upsert/create/assign
  methods. → registering a per-user secret at connect time is **wire-it-up**, not
  build-new-surface. Atrium needs an `iak_` API key + a thin HTTP client (a few calls).
- **Precedence: infra WINS over per-principal grants.** Per-principal placeholders are
  applied with `set_missing_env` (`iron_proxy.rs:~1307`), with an explicit comment
  *"set_missing so infra placeholders win."* A per-user `GITHUB_TOKEN` grant is therefore
  silently shadowed by `infra.yaml`. We **cannot** dodge with a different placeholder name
  because `entrypoint.sh` hardcodes `GITHUB_TOKEN` for `gh`/`git`. → the per-user value
  has to flow through that exact name, so the infra default must go (see core change).
- **`derive_principal` hook** — `derive_principal(thread_key, actor_user_id,
  conversation_name)` in `centaur-iron-control/src/principal.rs:68`, with arms for
  slack/discord/teams/linear + a `thread-<slug>` fallback. Thread a new `atrium_user_id`
  metadata field through `SessionPrincipalMetadata` (`session.rs:18`) ←
  `register_session` (`centaur-session-runtime/src/lib.rs:598`) ← spawn metadata `Value`.
  **Keep the user out of the thread_key** — thread_key is *session* identity (multiple
  sessions per user must not collide); the principal is derived from the metadata field.
- iron-control / console is **off by default** (`console.enabled: false`) — Route B
  requires standing it up.

## The core change: demote GitHub from infra-magic to a grant

This is the one non-mechanical change, and it's the elegant one. Remove the `GITHUB_TOKEN`
block from `infra.yaml`, and re-express GitHub entirely as grants:

- **global / no-connect default** → a `github-default` **role** holding a *minimal-scope*
  StaticSecret (public-repo read). Assigned to an `atrium-user` principal **only while it
  has not connected**.
- **per-user** → the user's own StaticSecret (Phase 0) or BrokerCredential (Phase 1),
  granted directly to their principal.

**Invariant: exactly one GitHub transform per principal at any time.** Atrium enforces it:
on connect, assign the per-user grant and *remove* the `github-default` role; on
disconnect, drop the grant and *re-assign* the default role. This avoids the two-transform
ambiguity (two `GITHUB_TOKEN` rules for the same host/header has undefined first-wins
behaviour — `effective_config` appends without dedup).

Do **not** flip `set_missing_env`→`set_env` globally — that would weaken the "infra wins"
invariant for *every* infra secret (Slack, OpenAI), a security-relevant change. Demoting
GitHub specifically keeps that invariant intact for everything else.

Net result: **one credential model — principals get grants.** Global = a default-role
grant; per-user = a user-principal grant; the App later = a broker-backed grant. No infra
special-case, no precedence hack.

## End-to-end flow (Phase 0)

1. User pastes a GitHub token in Atrium → "connect" handler.
2. Atrium calls iron-control: `PUT principals/atrium-user-<id>` →
   `PUT static_secrets/<foreign_id>` (source `control_plane`, value = token, rules: hosts
   `github.com` + `api.github.com`, header `Authorization`) → `POST grants` (principal ↔
   secret) → ensure `github-default` role **un**assigned. Atrium persists only status.
3. User starts a session → Atrium spawn includes metadata
   `{ atrium_user_id: <provider_credential_user_id> }`.
4. Centaur `derive_principal` → stable `atrium-user-<id>` principal; proxy syncs its
   effective_config (one GitHub transform — the user's). Sync barrier
   (`wait_for_proxy_principal_applied`) ensures it's applied before the box boots.
5. Sandbox boots; `entrypoint.sh` configures `gh`/`git` with the `GITHUB_TOKEN`
   placeholder; agent's `gh`/`git` calls hit the proxy; proxy swaps in the **user's**
   token on the wire. Real value never in the box.

## Phase 0 — paste-a-token, concrete diff

**Centaur (Rust, ~½ day + tests):**
1. `centaur-iron-control/src/principal.rs` — new arm: `surface:` thread_key + `atrium_user_id`
   metadata → `atrium-user-<id>`; + unit test. Update `derive_principal` signature.
2. `centaur-iron-control/src/session.rs` — add `atrium_user_id` to `SessionPrincipalMetadata`
   + extract from metadata `Value`.
3. `centaur-session-runtime/src/lib.rs:598` — pass the new field into `register_session`/
   `derive_principal`.
4. `centaur-iron-proxy/src/infra.yaml` — remove the `GITHUB_TOKEN` block.

**Atrium (TS, ~1–2 days):**
5. `surface/centaur-client` spawn — add `atrium_user_id = provider_credential_user_id` to
   spawn metadata.
6. `user_provider_credentials` — allow `provider='github'`, storing **status/metadata only**
   (connected, scopes, last-4), not the secret.
7. Thin iron-control client (upsert principal → upsert static_secret → create grant →
   assign/unassign `github-default` role) + a "connect" handler.
8. UI — "paste a token" advanced affordance (fine-grained or classic, accepted transparently).

**Deployment / ops (the real new work):**
- Stand up iron-control / console (`console.enabled: true`); provision an `iak_` API key for
  surface; make the URL reachable from `surface/server`.
- Provision a **minimal-scope** GitHub token as the `github-default` role's StaticSecret.
- One-time: ensure removing GitHub from `infra.yaml` doesn't regress any non-Atrium
  principals (assign `github-default` where appropriate).

## Phase 1 — GitHub App ("Connect")

- Register a GitHub App; "Connect GitHub" OAuth + installation callback in Atrium.
- Mint installation tokens → iron-control `BrokerCredential` (auto-refreshed) → wrapped in a
  StaticSecret → **same** grant/principal path as Phase 0. No change to the Phase 0 pipe.
- PAT remains the permanent escape hatch (orgs without the App installed, bootstrap).

## Validation

- Prove the pipe with **one pasted token (yours)** end-to-end first: connect → spawn →
  observe the proxy swap (agent's `gh api user` returns *your* identity; the real token is
  never present in the box's env / `.git-credentials`).
- Confirm a *non-connected* user falls back to the minimal default (public read works,
  private push denied).
- Confirm two concurrent sessions for two different users get two different identities.
- Then layer the App.

## Open questions / future

- **Workspace namespacing.** Chose global per-user (`default` namespace) for now. If
  multi-tenant, move to a per-workspace iron-control `namespace` — annoying to migrate
  foreign_ids later, so revisit before multi-tenant launch.
- **App token type.** Installation token (acts as the App, repo-scoped) vs user-to-server
  token (acts as the user). Decide at Phase 1; installation is the standard for repo access.
- **Rotation / disconnect.** PAT: re-enter. App: automatic. Disconnect must drop the grant
  and restore the `github-default` role.
- **Generalize.** Once per-user principals exist, the same mechanism carries per-user Slack
  and lets us migrate Claude/Codex **off** today's execute-time env-injection (which leaks
  the real token into the box) onto the proxy. That convergence retires the "two parallel
  credential systems" wart.

## Risks

- **`infra.yaml` demotion regressing non-Atrium principals** — mitigate with the
  `github-default` role; verify before/after.
- **Two-transform ambiguity** — mitigated by the one-transform invariant (connect ⇔ default
  role mutually exclusive).
- **console standup** — first time iron-control runs in the Atrium deployment; treat as the
  main operational unknown.

## Key file references

- Proxy / placeholder precedence: `centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs` (`effective_replace_placeholders` ~202, `set_missing_env` ~1307)
- Infra secrets: `centaur/services/api-rs/crates/centaur-iron-proxy/src/infra.yaml`
- Principal derivation: `centaur/services/api-rs/crates/centaur-iron-control/src/principal.rs:68`
- Session metadata: `centaur/services/api-rs/crates/centaur-iron-control/src/session.rs:18`
- Register session: `centaur/services/api-rs/crates/centaur-session-runtime/src/lib.rs:598`
- iron-control client (writes): `centaur/services/api-rs/crates/centaur-iron-control/src/client.rs`
- iron-control HTTP API docs: `centaur/services/console/docs/API.md`
- Sandbox gh/git setup: `centaur/services/sandbox/entrypoint.sh:657`
- Atrium spawn: `surface/server/src/session-runs.ts` (spawn) + `surface/centaur-client/src/client.ts`
- Atrium cred store: `surface/server/src/provider-credentials.ts`, `user_provider_credentials`
