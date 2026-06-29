# Per-user credentials - plan (per-user GitHub via iron-control)

**Status:** implementation landed in `feat/per-user-credentials`; GitHub App installation broker follow-up in `feat/github-installation-credentials` · **Date:** 2026-06-28 · **First consumer:** per-user GitHub (`gh` + `git` + private repo checkout)

## Problem

Today every agent sandbox authenticates to GitHub with a single shared org-global
`GITHUB_TOKEN`. It is installed and auto-authed in every box: the image has `gh`,
and `entrypoint.sh` runs `gh auth login --with-token` plus writes `.git-credentials`
from `$GITHUB_TOKEN`. The token is the same for every session and every user.

We want GitHub actions from a sandbox to use the credentials chosen for the user
who owns the session, and we want to shrink the blast radius of a shared token.
This plan does GitHub first, but it is the mechanism for per-user credentials in
general.

## Decisions

- **Route B: proxy / per-principal replacement.** The real token never enters the
  sandbox. The sandbox sends the placeholder `GITHUB_TOKEN`; iron-proxy swaps it
  for the principal's effective secret on the wire.
- **Credential owner = `sessions.provider_credential_user_id`.** This already
  means "act as this user's provider credentials" for Claude/Codex. Do not use
  `spawned_by` or `driver_id` for credential ownership.
- **Principals are workspace-scoped via foreign id prefix.** Use one global
  iron-control namespace for the first build, with one credential principal per
  workspace/user pair:
  `atrium-workspace-<workspace_id>-user-<user_id>`. Do not create
  per-workspace iron-control namespaces yet; keep the API shape capable of
  adding that later if tenant isolation needs it.
- **iron-control is the secret system of record.** Atrium stores only
  connection status/metadata: connected state, token kind, scopes/permissions,
  account/login, last 4 where useful, validation/error timestamps. It must not
  duplicate GitHub token material at rest.
- **No-connect fallback = public-read default.** Keep a minimal shared default
  that supports public GitHub reads, not the current full org token. Connecting
  GitHub upgrades the principal to user/app credentials.
- **Unified Connections model.** GitHub and future connector state should live
  in one workspace/user connection model, not in a GitHub-only table and not as
  another Claude/Codex-shaped token row. Legacy provider credential APIs can
  remain as adapters during the transition.
- **GitHub App supports both identity modes.** Installation tokens are good for
  repo-scoped app automation; user access tokens are needed when the product
  promise is literally "act as me." Default selection is automatic by
  workspace/repo policy, with an advanced override at spawn time.
- **Private repo checkout is in scope.** The first build should cover both
  in-sandbox `gh`/`git` calls and session-start checkout of private repos. Tool
  overlay bootstrap remains separate unless it is part of the session's target
  repo path.

## Context: how credentials reach sandboxes today

Three tiers exist; only the first is inherently global:

| Tier | Where | Per-user? |
|---|---|---|
| Infra secrets | `centaur/services/api-rs/crates/centaur-iron-proxy/src/infra.yaml` (`GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, model keys) | No: plain env lookup on the proxy pod |
| Principal-granted static secrets | iron-control `Grant`s | Yes: value differs per principal |
| Broker credentials | iron-control `BrokerCredential` + token-broker-backed secret | Yes: OAuth lifecycle per credential |

The sandbox sees placeholder values. For GitHub, `entrypoint.sh` configures
`gh` and `.git-credentials` from `GITHUB_TOKEN`; iron-proxy replaces that
placeholder on outbound requests to `github.com` and `api.github.com`.

## Verified facts

- iron-control already has bearer-auth write APIs for principals, roles,
  static secrets, broker credentials, grants, and role assignment. The Rust
  `IronControlClient` has the required upsert/create/list/delete methods.
- Infra placeholders win over per-principal placeholders. `apply_proxy_env`
  calls `set_missing_env` for effective placeholders so existing infra env wins.
  Therefore a per-user `GITHUB_TOKEN` grant is shadowed while `GITHUB_TOKEN`
  remains in `infra.yaml`.
- `derive_principal(thread_key, actor_user_id, conversation_name)` is the hook
  that maps a session to an iron-control principal. Atrium should add explicit
  workspace/user metadata and keep the user out of `thread_key`; the thread key
  remains session identity.
- Console / iron-control is off by default (`console.enabled: false`), so this
  work includes standing it up and provisioning an `iak_` key for `surface`.
- Existing principals do not automatically receive default roles on every
  session registration. `SessionRegistrar` assigns startup roles only when the
  principal is first created, by design, so GitHub default assignment must be
  owned by Atrium or an explicit migration/reconciler.

## Core change: demote GitHub from infra-magic to grants

Remove the `GITHUB_TOKEN` transform from `infra.yaml`. Re-express GitHub through
iron-control grants:

- **Public-read fallback**: `github-default` role holding a minimal public-read
  GitHub static secret. Atrium assigns this role to disconnected
  workspace/user principals.
- **User PAT**: a principal direct grant to a `control_plane` static secret with
  `replace_config.proxy_value = "GITHUB_TOKEN"`.
- **GitHub App installation token**: a broker credential plus token-broker-backed
  static secret, granted directly to the principal when app identity is desired.
- **GitHub App user access token**: a broker-backed secret granted directly to
  the principal when literal user identity is desired.

Invariant: each workspace/user principal has exactly one GitHub transform for
`GITHUB_TOKEN` at any time.

Do not flip `set_missing_env` to `set_env` globally. That would weaken the
"infra wins" invariant for other secrets such as Slack/model credentials.
Demote GitHub specifically.

## Atrium-owned credential state machine

Atrium owns GitHub role/grant convergence, not Centaur startup role assignment.
`github-default` must not be included in Centaur's normal `assign_role_ids`.

Per workspace/user principal:

| State | Direct GitHub grant | `github-default` role | Meaning |
|---|---:|---:|---|
| disconnected | no | yes | public-read fallback only |
| connected_pat | yes | no | PAT-backed user identity |
| connected_app_installation | yes | no | app installation identity |
| connected_app_user | yes | no | GitHub App user identity |
| needs_auth | no | yes | credential failed or was revoked; fallback restored |

Connect, disconnect, rotation, and auth-failure repair must serialize per
workspace/user principal. A simple per-principal advisory lock or transaction
guard in `surface/server` is enough. The critical point is that a spawn must not
observe both a direct user/app grant and `github-default`.

Preferred connect ordering:

1. Upsert principal.
2. Upsert replacement secret.
3. Create/reuse direct grant.
4. Remove `github-default`.
5. Persist Atrium metadata as connected.
6. Optionally verify effective config has exactly one GitHub transform.

Preferred disconnect/auth-failure ordering:

1. Delete/revoke direct GitHub grant.
2. Assign `github-default`.
3. Persist Atrium metadata as disconnected or needs_auth.
4. Optionally verify effective config has exactly one GitHub transform.

If any step fails after iron-control has changed, retry convergence from desired
state rather than assuming each handler is one-shot.

## End-to-end flow: Phase 0 PAT

1. User pastes a fine-grained or classic GitHub token in Atrium.
2. Atrium validates enough metadata to display account, kind/scopes when
   available, and last 4; it does not persist the token.
3. Atrium calls iron-control:
   - upsert workspace/user principal,
   - upsert static secret with `source_type = control_plane`,
   - rules for `github.com` and `api.github.com`,
   - `replace_config` for `Authorization` and `proxy_value = "GITHUB_TOKEN"`,
   - create/reuse grant,
   - remove `github-default`.
4. Atrium persists GitHub connection metadata only.
5. User starts a session. `surface/server` includes workspace/user credential
   metadata, selected GitHub identity mode, and repo checkout needs in Centaur
   spawn metadata.
6. Centaur derives the workspace/user principal and persists its OID on the
   session.
7. If the session has a private GitHub repo target, Centaur checks it out using
   the same workspace/user principal's GitHub transform. This may require
   routing repo checkout through the per-sandbox proxy or adding a node-side
   checkout path that can bind to the session principal before clone.
8. The proxy sync barrier applies the principal config before the box can make
   credentialed calls.
9. Sandbox boots. `entrypoint.sh` configures `gh`/`git` with the `GITHUB_TOKEN`
   placeholder. Real token material is only present in iron-control/proxy, never
   in the sandbox env, `.git-credentials`, logs, or artifacts.

## Phase 0 concrete diff

Centaur:

1. `centaur-iron-control/src/principal.rs`: add a `surface:` arm that requires
   workspace/user metadata and returns
   `atrium-workspace-<workspace_id>-user-<user_id>`.
2. `centaur-iron-control/src/session.rs`: extend `SessionPrincipalMetadata` with
   `atrium_workspace_id` and `atrium_user_id`; extract from session metadata.
3. `centaur-session-runtime/src/lib.rs`: pass session metadata through the
   existing registration path; add tests for surface principal derivation.
4. `centaur-iron-proxy/src/infra.yaml`: remove the `GITHUB_TOKEN` block.
5. Tests: verify infra GitHub is gone, surface metadata maps to stable
   workspace/user principals, and existing chat principal behavior is unchanged.
6. Private repo checkout: make session repo clone use the selected
   workspace/user GitHub principal instead of a shared Kubernetes GitHub token.
   Keep tool overlay/repo-cache credentials separate unless that path is used
   for the user's target repo checkout.

Atrium:

1. `surface/server` spawn path: include `atrium_workspace_id`,
   `atrium_user_id = provider_credential_user_id`, selected GitHub identity
   mode, and repo checkout policy in Centaur spawn metadata. This belongs in
   the server spawn flow because the server chooses the credential owner.
2. Add a unified connection store. Current `user_provider_credentials` has
   `token_ciphertext NOT NULL` and is Claude/Codex-shaped, so introduce a
   metadata-only `user_connections`/`workspace_user_connections` model keyed by
   `(workspace_id, user_id, provider)` and keep the old Claude/Codex provider
   credential APIs as compatibility adapters until those providers move over.
3. Add an iron-control client in `surface/server` for principal, static secret,
   grant, role assignment, role unassignment, grant deletion, and effective
   config verification.
4. Add connect, disconnect, rotate/reconnect, and auth-failure convergence
   handlers with per-principal serialization.
5. Add UI for GitHub connection state. PAT is the advanced escape hatch; GitHub
   App identity mode is auto-selected by policy with an advanced spawn override.

UI / UX affordances:

- Settings popover: add a compact `GitHub` row next to Claude Code and Codex.
  States: `Connected`, `Public read`, `Needs auth`. The row opens the GitHub
  connection dialog.
- GitHub connection dialog: primary action is GitHub App connect. Show the
  connected account, workspace, identity modes available, repo access summary,
  last validation, and disconnect/reconnect actions. Keep "Paste token" behind
  an advanced disclosure in the same dialog, not as a separate top-level path.
- Spawn dialog: only show GitHub controls when repo is set or the task is
  repo-scoped. Default to automatic identity selection. Add an advanced
  identity selector with options like `Automatic`, `App installation`, `User`,
  `PAT` when those credentials are available. Surface the resolved identity in
  compact copy before start, e.g. `GitHub: app install for acme/widgets` or
  `GitHub: @gary as user`.
- Spawn repo validation: if a private repo is entered and no connected
  credential can access it, show an inline action to connect GitHub instead of
  allowing an opaque checkout failure.
- Session banner: reuse the existing provider-auth banner pattern for GitHub
  auth failures. Owner sees a `Reconnect GitHub` action; non-owners see who is
  needed.
- Session details / audit copy: expose which GitHub identity mode was used for
  a run, without showing secrets.

Deployment / ops:

- Enable console / iron-control and worker (`console.enabled: true`).
- Provision a surface `iak_` API key and route `surface/server` to console.
- Provision the minimal public-read GitHub default as the `github-default` role.
- Run a one-time reconciliation for existing Atrium workspace/user principals:
  connected users get direct grant only; disconnected users get `github-default`.
- Confirm non-Atrium principals are not relying on the removed infra GitHub
  transform, or assign an explicit role where needed.

## Phase 1: GitHub App Connect

Support both token modes:

- **Installation token**: repo-scoped app automation. Good default for bot-like
  tasks, org-managed installs, and short-lived repo access. User-visible copy
  should say the app is acting through the installation, not literally as the
  human.
- **User access token**: literal user identity. Use when the session should
  perform user-attributed API actions and respect the user's access in addition
  to app permissions.

Both modes still feed the same principal/grant/proxy path. Selection is
automatic by workspace/repo policy, with an advanced spawn override:

1. OAuth/install callback creates or updates a broker credential.
2. A token-broker-backed static secret defines the GitHub replacement rules.
3. The secret is granted directly to the workspace/user principal.
4. `github-default` is removed.

Implementation note: GitHub App user OAuth uses the refresh-token broker when
the GitHub App has expiring user tokens enabled. Installation-token mode uses
the Centaur console `github_app_installation` broker grant, which signs a
GitHub App JWT with the encrypted app private key and exchanges it for a
short-lived installation token. Surface creates that broker credential from the
installation id and wraps it in the same token-broker-backed `GITHUB_TOKEN`
static secret used by private repo checkout.

PAT remains the permanent escape hatch for bootstrap, unsupported org policies,
and cases where an App install is unavailable.

## Generalizing beyond GitHub

Centaur already discovers many built-in tool credentials from
`centaur/tools/**/pyproject.toml` and registers them into iron-control. Today
they are folded into the shared `infra` role, so every session principal gets
the same deployment-level credential when the tool is enabled. That is correct
for some services and wrong for others.

Use this rule:

- **Per-user or per-workspace by default** when the credential grants access to
  a user's SaaS workspace, private data, or action surface.
- **Shared infra by default** when the credential buys commodity capacity,
  public/reference data, model access, browser/rendering capacity, telemetry, or
  Centaur's own runtime plumbing.
- **Bot/runtime global** when the credential is the service identity for an
  ingress bot, webhook verifier, image pull, artifact capture, or internal API.

High-priority connectors that should get the same Atrium-owned principal/grant
state machine as GitHub:

| Connector | Current secret(s) | Recommended ownership |
|---|---|---|
| Slack tool/search | `SLACK_BOT_TOKEN`, `SLACK_SEARCH_TOKEN`, `SLACK_ETL_TOKEN` | Workspace-scoped; user token where product needs "act as me," bot token where workspace bot is intended |
| Google Workspace | `GOOGLE_TOKEN_JSON` | User or workspace OAuth broker credential |
| Linear | `LINEAR_API_KEY` | Workspace/user connector, depending on org policy |
| Notion | `NOTION_API_KEY` | Workspace connector |
| Figma | `FIGMA_ACCESS_TOKEN` | User/workspace connector |
| Airtable | `AIRTABLE_API_KEY` | Workspace connector |
| Sentry/PostHog/Grafana/Amplitude | service-specific API keys | Workspace/team connector; sometimes read-only shared workspace credential |
| Attio/Pylon/Ashby/Granola/Composio | service-specific API keys | Workspace connector |

Good candidates to remain shared infra unless a customer explicitly brings their
own quota or data boundary:

| Category | Examples |
|---|---|
| Market/public data APIs | Etherscan, Alchemy, Dune, CoinGecko, CoinMetrics, Nansen, Arkham, DefiLlama, Messari, Token Terminal, Tokenomist, EODHD |
| Research/reference APIs | NewsAPI, Crunchbase, SimilarWeb, Harmonic, ListenNotes, LegiStorm, Congress/OpenFEC/Data.gov, YouTube |
| Browser/document/media capacity | Browser Use, Reducto, Google media/model keys for Nano Banana/Veo |
| Model/harness capacity | OpenAI, Anthropic, xAI, Gemini, AMP, Parallel when used as platform-provided capacity |

Credentials that should stay runtime-global and not be modeled as user
connectors:

- Slack/Discord/Teams/Linear bot ingress tokens and webhook signing secrets.
- `ATRIUM_CAPTURE_API_KEY`, node-sync keys, sandbox API tokens, image pull
  secrets, iron-control API keys, iron-proxy management/proxy tokens.
- Console encryption keys, database URLs, Rails `SECRET_KEY_BASE`, and other
  control-plane bootstrap secrets.

Product implication: do not make a giant connector UI for every declared tool
secret. Start with a small `Connections` model that can back GitHub, then reuse
it for the high-priority collaboration SaaS connectors above. Workspace-level
connectors are managed by workspace admins. Personal user credentials are added
only when the product needs literal user identity or a user-scoped private data
boundary.

Do not expose BYO credentials for commodity APIs in the first build. Market
data, research APIs, browser/rendering services, and model capacity remain
platform-default credentials for now. If cost/quota ownership becomes important,
add admin-level BYO later; do not clutter the user connection surface with
low-identity API keys.

## Validation

Required end-to-end checks:

- Connected PAT user: spawn session, run `gh api user`, confirm returned account
  matches the pasted token.
- Connected app-installation user: confirm API behavior and attribution match
  app installation semantics.
- Connected app-user user: confirm `gh api user` and user-attributed actions
  match the connected user.
- Disconnected user: public read works; private read and writes fail.
- Private repo checkout succeeds for a connected user/app with repo access and
  fails clearly before spawn or at checkout for a principal without access.
- Two concurrent sessions in different workspace/user principals get different
  identities.
- Auto identity selection chooses the expected mode, and the advanced spawn
  override routes checkout plus in-sandbox `gh`/`git` through the selected mode.
- Connect/disconnect during spawn cannot produce two GitHub transforms in
  `effective_config`.
- The real token is absent from sandbox env, `.git-credentials`, shell history,
  process args, logs, session events, and captured artifacts. Placeholder values
  may exist and should be expected.

## Out of scope / explicit non-goals

- Tool overlay/repo-cache GitHub tokens for installing Atrium/Centaur tools are
  separate bootstrap paths today. Keep them separate unless they are also used
  for the session's target repo checkout path. The user's target repo checkout
  is in scope for this plan.
- Migrating Claude/Codex off execute-time env injection is a follow-up. This
  mechanism makes that possible, but GitHub should land first.

## Risks

- **Identity mismatch:** installation tokens do not literally act as the user.
  Mitigate by supporting both installation and user-token modes and making the
  selected mode visible in product/API state.
- **Two-transform ambiguity:** duplicate `GITHUB_TOKEN` transforms have
  undefined first-wins behavior. Mitigate with per-principal serialized
  convergence and effective-config verification.
- **Existing principals missing fallback:** Centaur does not reassign default
  roles to existing principals. Mitigate with an explicit Atrium/ops
  reconciliation.
- **Schema mismatch:** current provider credential storage expects encrypted
  token material. Mitigate with metadata-only GitHub connection schema.
- **Console standup:** first production use of iron-control in Atrium. Treat
  this as the main operational validation item.

## Key file references

- Proxy placeholder precedence: `centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs`
- Infra GitHub transform: `centaur/services/api-rs/crates/centaur-iron-proxy/src/infra.yaml`
- Principal derivation: `centaur/services/api-rs/crates/centaur-iron-control/src/principal.rs`
- Session metadata: `centaur/services/api-rs/crates/centaur-iron-control/src/session.rs`
- Session registration: `centaur/services/api-rs/crates/centaur-session-runtime/src/lib.rs`
- iron-control client: `centaur/services/api-rs/crates/centaur-iron-control/src/client.rs`
- iron-control API docs: `centaur/services/console/docs/API.md`
- Sandbox GitHub setup: `centaur/services/sandbox/entrypoint.sh`
- Atrium spawn owner: `surface/server/src/session-runs.ts`
- Atrium credential store: `surface/server/src/provider-credentials.ts`, `surface/server/migrations/035_provider_credentials.sql`
