# Artifact App Action Proxy Design

Status: design note, updated for Centaur iron-control changes on 2026-07-15.
See also `artifact-apps-centaur-connector-addendum.md` for the Centaur-specific
credential-plane implications behind this revision.

This document covers the next layer after static artifact apps: allowing a
published artifact app to ask Atrium to perform a narrow, typed action. It is
not the static app hosting path itself. Static hosting should keep the existing
shape: isolated apps origin, signed launch URL, sandboxed iframe, and strict CSP.

## Decision

Keep the browser artifact app static and sandboxed. Add an Atrium action proxy
between the iframe and any privileged operation.

The Centaur changes alter the credential layer, not the browser boundary. Do not
invent an artifact-specific API-key system for outside apps. Use Atrium for app,
version, user, channel, capability, idempotency, confirmation, and audit checks;
then execute the action server-side using Atrium internal adapters or
iron-control-backed credentials.

```text
artifact iframe
  postMessage(action, payload, idempotencyKey)
Atrium web shell
  checks frame origin + app launch context
Atrium server
  checks app version, viewer, workspace/channel, declared capability,
  confirmation policy, idempotency, rate limit, and audit trail
Surface adapter or worker
  executes Atrium/internal action directly, or calls external API through
  an iron-control-backed grant
```

The artifact iframe must not receive raw API keys, OAuth access tokens, Centaur
admin keys, or broad bearer tokens.

## What Centaur changes

Centaur now has a useful substrate for credentials that previously looked like
something artifact apps might need to build themselves:

- principals for users, channels, and execution contexts;
- roles and direct grants;
- OAuth broker credentials with refresh handled outside the app;
- static/header injection, OAuth-token injection, and Postgres DSN routing;
- request rules that bind credentials to specific hosts/headers/paths;
- proxy sync so a sandbox or worker proxy gets only the active principal's
  effective config.

That means artifact app actions should reuse this credential plane when an action
needs an outside service. The action proxy still belongs in Surface because it
knows Atrium users, sessions, channels, app versions, and UI confirmation state.
Centaur should not become the browser-facing authorization layer for artifact
apps.

## Non-goals

- Letting generated apps make arbitrary network requests.
- Giving apps API keys for Atrium.
- Letting apps call Centaur or iron-control directly.
- Running generated server code for v1.
- Relaxing static app CSP broadly. Network access should be introduced through a
  typed bridge, not `connect-src *`.

## App Identity

Every action request must bind to an immutable app version, not just an app name.
Use the existing app registry concepts:

- `app_id`
- `version`
- `workspace_id`
- optional `channel_id`
- `entry_path`
- launch grant / launch instance id
- current viewer user id

The server should reject actions for unpublished apps, stale or unknown versions,
and app versions the viewer could not launch.

## Manifest Contract

Extend `atrium.app.json` with explicit action declarations. The manifest should
describe intent; it should not contain secrets.

```jsonc
{
  "name": "member-tools",
  "kind": "static",
  "entry": "index.html",
  "actions": {
    "atrium.channel.add_member": {
      "title": "Add member to channel",
      "description": "Invite a workspace user into the current channel.",
      "confirm": "always",
      "idempotency": "required",
      "input_schema": {
        "type": "object",
        "required": ["channel_id", "user_id"],
        "properties": {
          "channel_id": { "type": "string", "format": "uuid" },
          "user_id": { "type": "string", "format": "uuid" }
        },
        "additionalProperties": false
      }
    }
  }
}
```

Manifest validation should happen at publish time. Launch should expose only the
validated action names and schemas for that frozen version.

## Browser Bridge

The iframe should communicate with the Atrium web shell by `postMessage`.

Request:

```json
{
  "type": "atrium.action.request",
  "request_id": "client-generated-id",
  "action": "atrium.channel.add_member",
  "payload": { "channel_id": "...", "user_id": "..." },
  "idempotency_key": "uuid-or-stable-operation-id"
}
```

Response:

```json
{
  "type": "atrium.action.response",
  "request_id": "client-generated-id",
  "ok": true,
  "result": { "status": "added" }
}
```

The web shell is responsible for:

- accepting messages only from the iframe it launched;
- attaching app launch context the iframe cannot forge;
- showing confirmation UI when policy requires it;
- sending the request to Surface with same-origin user credentials;
- returning only the result shape allowed for that action.

## Server Route Shape

V1 can use one generic route:

```text
POST /api/apps/:appId/versions/:version/actions/:action
```

Request body:

```json
{
  "launch_id": "...",
  "request_id": "...",
  "idempotency_key": "...",
  "payload": {}
}
```

Required server checks:

- user is authenticated;
- user can still access the app's workspace/channel;
- app and version are published;
- `launch_id` was minted for this user/app/version and is unexpired;
- action exists in the frozen manifest;
- payload validates against the frozen input schema;
- action is permitted in this app scope;
- confirmation requirement is satisfied;
- idempotency key is present for writes and scoped to user/app/version/action;
- rate limits pass;
- full request and outcome are audited without logging secrets.

## Capability Model

Use separate namespaces for action capabilities:

- `atrium.*` for native Atrium operations;
- `connector.<provider>.*` for outside app operations;
- `db.<name>.*` for explicitly configured database actions;
- `custom.<slug>.*` for later operator-defined adapters.

For Atrium-native actions, Surface can execute directly after checking the
viewer has the same permission the normal UI/API would require.

For outside app actions, Surface should resolve the viewer/channel principal and
execute through a server-side adapter or worker that uses iron-control-backed
credentials. The app sees neither the credential nor the upstream host-level
proxy config.

## Confirmation And Writes

Read-only actions may be allowed without an interstitial if the manifest and
workspace policy permit it.

Writes should require:

- a human-visible preview of the target and effect;
- explicit confirmation for the first version of v1;
- idempotency key;
- action-specific validation;
- audit entry with app id, version, user, channel/workspace, action, payload
  summary, result status, and upstream request id when available.

Dangerous or broad actions should stay out of v1.

## Credential Handling

Do not add artifact app API keys.

When an external credential is needed:

1. The user or operator connects the upstream account through the normal
   connection / iron-control path.
2. The credential is represented as an iron-control broker/static/OAuth/Postgres
   secret with request rules.
3. A role or direct grant gives the relevant principal access.
4. The Surface action adapter executes under that principal and receives only the
   narrow effective credential path it needs.

This keeps the static artifact app model intact while reusing Centaur's newer
credential plane.

## V1 Slice

Start with one Atrium-native write action and one read action.

Suggested first actions:

- `atrium.channel.list_members`
- `atrium.channel.add_member`

This tests the end-to-end action proxy without external credentials:

- manifest declaration;
- postMessage bridge;
- same-origin Surface action route;
- user/channel permission check;
- confirmation UI for write;
- idempotency;
- audit event.

Only after that should we add an external action backed by iron-control, for
example a read-only GitHub or Google Sheets action.

## Data Model Additions

Likely tables:

- `app_action_manifests`
  - app id, version, action name, schema, policy, created timestamp
- `app_action_invocations`
  - app id, version, user id, workspace/channel, action name, idempotency key,
    payload hash, status, result summary, error code, upstream request id,
    timestamps

If the manifest JSON is already frozen in app version metadata by the time this
is built, `app_action_manifests` can be derived instead of stored separately.
The invocation/audit table is still useful.

## Security Invariants

- App action authority comes from the current viewer plus the frozen app version,
  not from generated code.
- The iframe cannot mint its own app identity.
- The iframe cannot call Surface APIs directly; CSP remains narrow and the web
  shell is the bridge.
- The server revalidates everything the web shell claims.
- Secrets stay outside the iframe and outside artifact source files.
- External credentials are scoped by principal and request rules.
- Every write is idempotent and audited.

## Open Questions

- Should action availability be granted at publish time, launch time, or both?
- Does app action approval belong to the app version, the app name, or the
  workspace/channel policy?
- What is the right UX for recurring trust: always confirm, trust this version,
  or trust this action for this channel?
- Should action adapters run inside Surface, a worker, or a Centaur-managed
  execution context once external credentials are involved?
- How much of the iron-control principal mapping should Surface own directly vs.
  delegate to Centaur APIs?
