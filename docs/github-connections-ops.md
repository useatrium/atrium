# GitHub Connections Operations

This runbook covers the per-user GitHub connection cutover for Atrium sessions
that route `gh`, `git`, and GitHub API traffic through Centaur's iron-proxy.
The goal is one effective `GITHUB_TOKEN` replacement per
`workspace_id`/credential-owner `user_id` principal at run time, with no real
GitHub token in sandbox env, logs, artifacts, or Atrium's database.

## Required Config

Surface needs iron-control admin access:

```sh
IRON_CONTROL_BASE_URL=https://<console-host>
IRON_CONTROL_API_KEY=iak_...
IRON_CONTROL_NAMESPACE=default
```

The primary GitHub UI uses GitHub App user OAuth and requires expiring user
tokens on the GitHub App:

```sh
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_REDIRECT_URL=https://<surface-host>/api/me/connections/github/callback
```

GitHub App installation-token mode uses iron-control's
`github_app_installation` broker grant. Surface creates the broker credential
from the installation id and these app credentials:

```sh
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----...'
GITHUB_APP_PRIVATE_KEY_ID=... # optional
GITHUB_APP_FALLBACK_INSTALLATION_ID=... # optional, pins the github-default installation
GITHUB_PUBLIC_READ_TOKEN=... # optional, seeds github-default fallback
```

The private key is sent only to iron-control, stored encrypted there, and is not
stored in Atrium. The broker mints short-lived installation tokens from GitHub's
`/app/installations/:installation_id/access_tokens` endpoint and delivers the
current token through the existing `token_broker` `GITHUB_TOKEN` replacement.

Centaur must run with console / iron-control enabled:

```yaml
console:
  enabled: true
  worker:
    enabled: true
```

Provision the `github-default` role in the same namespace as Surface. When the
GitHub App is configured (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`), Surface
backs the role with a `github_app_installation` broker secret instead of the
static token: it uses `GITHUB_APP_FALLBACK_INSTALLATION_ID` when set, otherwise
it auto-discovers the App's single installation (zero or multiple installations
log a warning and keep the static path). Otherwise, if
`GITHUB_PUBLIC_READ_TOKEN` is set, Surface seeds the role's minimal public-read
GitHub fallback secret and role grant idempotently. If neither is available,
pre-provision that static secret and grant in iron-control. The fallback secret
must replace the placeholder `GITHUB_TOKEN` for `github.com` and
`api.github.com`. Do not include `github-default` in Centaur's normal startup
`assign_role_ids`; Atrium owns assignment and removal for workspace/user
principals.

The GitHub infra transform must be removed from
`centaur/services/api-rs/crates/centaur-iron-proxy/src/infra.yaml` before the
cutover. If `GITHUB_TOKEN` remains in infra config, it shadows principal grants.

## Connector Scope

This runbook is GitHub-specific because GitHub is both a sandbox tool credential
(`gh`, `git`, private checkout) and an Atrium user-facing connection. Do not
blindly apply the same cutover to every credential-shaped setting in Centaur:

| Credential family | Current treatment | Same Atrium Connections treatment? |
| --- | --- | --- |
| GitHub `GITHUB_TOKEN` | Workspace/user principal grant owned by Surface; no shared infra fallback except public-read role | Yes, this runbook |
| Claude/Codex subscription auth | Atrium `user_provider_credentials`; injected by Surface at execute time | Later, when legacy provider credential APIs are adapted into unified Connections |
| Google/Slack OAuth broker credentials in Centaur console | Brokered OAuth credentials for console jobs/imports/sync paths | Only when Atrium exposes those as user-scoped product connections; keep broker lifecycle in iron-control |
| Slack bot/app tokens, model API keys, storage/service credentials | Infra/operator secrets | No; these are service credentials, not user-selected sandbox identities |

Rule of thumb: use the unified `user_connections` model when a workspace user is
choosing the identity an Atrium session or connector should act as. Keep
operator-owned service credentials in infra or console-managed roles, and keep
token material out of Atrium either way.

## Runtime Model

Atrium stores GitHub connection metadata in two layers:

- `user_connections`: the current effective GitHub identity for a
  workspace/user/provider.
- `user_connection_identities`: saved GitHub identities for the same
  workspace/user/provider. Each identity has an `identity_id` such as
  `github:pat`, `github:app_user`, or
  `github:app_installation:<installation_id>`.

New GitHub identities get per-identity iron-control static secrets. The current
principal grant is switched by activating the selected identity, revoking stale
direct GitHub grants for the same principal, and verifying the principal still
has exactly one GitHub `GITHUB_TOKEN` transform. Older identities that predate
per-identity static secret metadata may appear in the UI but require reconnect
before they can be activated for a session.

Spawn-time identity override accepts a saved identity id. If the identity is not
already active, Surface activates it under the workspace/user GitHub connection
lock before repository validation and Centaur spawn. This means the advanced
spawn selector changes the workspace/user principal's current GitHub grant, not
only that single session's metadata.

## Big Cutover

1. Deploy Centaur with console enabled and the GitHub infra transform removed.
2. Deploy Surface with `IRON_CONTROL_BASE_URL`, `IRON_CONTROL_API_KEY`, and
   `IRON_CONTROL_NAMESPACE` set.
3. Seed or verify `github-default` and its public-read static secret.
4. Run reconciliation for every existing Atrium workspace/user credential
   principal:
   - connected GitHub users: direct GitHub grant exists, `github-default` absent
   - disconnected or `needs_auth` users: no direct GitHub grant,
     `github-default` present
   - saved identities: identities without `staticSecretId` metadata are usable
     as display/history only until the user reconnects them
5. Spawn validation sessions for connected and disconnected users.
6. Confirm proxy effective config has exactly one GitHub transform for each
   sampled principal.

## Reconciliation

Reconciliation is idempotent and should converge from desired state instead of
assuming the previous handler completed. For each
`atrium-workspace-<workspace_id>-user-<user_id>` principal:

- `connected`: upsert the principal, upsert/reuse the active user/app GitHub
  secret, ensure the direct grant exists, revoke stale direct GitHub grants
  known from inactive saved identities, and unassign `github-default`.
- `public_read` / absent row: upsert the principal, delete or revoke direct
  GitHub grants owned by Atrium for that principal, and assign `github-default`.
- `needs_auth`: revoke the direct GitHub grant, assign `github-default`, and
  keep the metadata row with the auth error.
- saved identity activation: require the identity's `metadata.staticSecretId`,
  grant that static secret directly to the principal, revoke stale direct grants
  for other saved identities, unassign `github-default`, mark that identity
  active, and update `user_connections` to match.

After each batch, sample `effective_config` from iron-control and count
transforms that replace `GITHUB_TOKEN` for GitHub hosts. The expected count is
exactly one.

## Rollback

Fast rollback restores the old shared-token behavior:

1. Disable GitHub connection writes in Surface by unsetting
   `IRON_CONTROL_BASE_URL` or `IRON_CONTROL_API_KEY` and redeploying Surface.
   Existing metadata remains but no new PAT convergence can run.
2. Re-add the `GITHUB_TOKEN` infra transform in Centaur's iron-proxy
   `infra.yaml`.
3. Restore the shared Kubernetes/runtime `GITHUB_TOKEN` secret with the intended
   reduced scope.
4. Redeploy Centaur iron-proxy/api pods.
5. Verify a disconnected test session can perform the expected public GitHub
   read and that private/write operations match the restored shared token's
   scope.

Data rollback is not required for the fast path because Atrium stores only
connection metadata. If the feature is fully backed out, leave
`user_connections` and `user_connection_identities` rows in place or delete only
`provider = 'github'` rows after confirming no older binary expects them.

If only saved-identity activation needs to be rolled back, disable the
`/api/me/connections/github/active` and spawn `githubIdentityId` paths in
Surface while leaving connect/disconnect convergence enabled. Existing active
connections continue to work through `user_connections`; inactive saved
identities remain metadata until activation is re-enabled or the user reconnects
them.

## Audit Expectations

Surface logs structured `github_connection_audit` events for connection
convergence. Required fields:

- `action`: `connect`, `disconnect`, `activate`, or `needs_auth`
- `result`: `success` or `failure`
- `workspace_id`
- `actor_user_id`
- `credential_owner_user_id`
- `principal_foreign_id`
- `token_kind`: `pat`, `app_installation`, `app_user`, or `public_read`
- `status`, `connected`, `account_login`, `scopes` when known

Token material must never appear. Metadata and capabilities may be included only
after redaction; secret-shaped keys such as `token`, `secret`, `credential`,
`authorization`, `password`, `private_key`, and `refresh_token` must be logged as
`[redacted]`. The allowed PAT-derived value is `last4`.

Centaur / iron-proxy logs remain the request-level audit trail. Use them to
verify outbound GitHub host, principal, session/proxy identifiers, status, and
timing. They must not include `Authorization` values or substituted token bytes.

## Validation Checklist

- Connected PAT user: `gh api user` returns the connected account.
- Connected app-installation user: private repo access follows installation
  repository scope and UI copy says App installation, not human user.
- Connected app-user user: `gh api user` returns the connected user.
- Disconnected user: public reads work; private reads and writes fail.
- Two workspace/user principals resolve to different GitHub identities.
- Saved identity override: spawning with an inactive saved identity id activates
  that identity, records `provider_connection_id = <identity_id>`, and validates
  private repo access through that identity's static secret or broker
  credential.
- Connect/disconnect during spawn never yields two GitHub transforms in
  `effective_config`.
- Private repo checkout uses the same workspace/user principal as in-sandbox
  `gh`/`git`.
- Sandbox env, `.git-credentials`, shell history, logs, session records, and
  artifacts contain only `GITHUB_TOKEN` placeholders or redacted values.
