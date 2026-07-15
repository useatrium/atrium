# Artifact Apps Centaur Connector Addendum

Status: addendum to the artifact app action proxy design, written after the
Centaur iron-control / connector changes were reviewed on 2026-07-15.

## Short Version

Rethink the credential layer, not the browser action proxy.

Centaur now has the right substrate for outside-app credentials: principals,
roles, grants, OAuth broker credentials, static/header injection, request rules,
Postgres DSN routing, and proxy sync. Artifact apps should still call typed
Atrium app actions from the browser. Those server-side actions should use
iron-control-backed grants instead of a new artifact-specific API-key system.

Main implication: keep browser artifacts static and sandboxed. Do not let them
become arbitrary privileged network clients. Use the action proxy for
app/version/user/channel/capability/idempotency/audit checks, then have Surface
or a worker execute against Atrium/internal adapters or external APIs using
Centaur's credential plane.

## What Changed In Centaur

The relevant Centaur pieces now exist in the vendored tree:

- `centaur/services/api-rs/crates/centaur-iron-control` has an admin client for
  principals, roles, grants, secrets, broker credentials, Postgres DSNs, and
  effective config.
- `centaur/services/console` owns the iron-control UI and persistence model.
- `centaur/docs/public/md/secrets/oauth-apps.md` describes user-connected OAuth
  apps and grantable refreshed tokens.
- `centaur/docs/public/md/secrets/advanced-permissioning.md` describes principal
  and role grants.
- `surface/server/src/iron-control.ts` and `surface/server/src/github-iron-control.ts`
  show Surface already integrating with this plane for GitHub credentials.

Before this existed, artifact app actions looked like they might need a small
credential system of their own: generate Atrium API keys, hand a scoped key to a
mini-app, and let that app call a generic proxy. That is the wrong direction now.

## Revised Responsibility Split

Artifact app browser runtime:

- renders static files from the apps origin;
- stays inside a sandboxed iframe;
- requests typed actions through the web shell;
- never receives raw credentials.

Atrium web shell:

- validates the iframe it launched;
- attaches launch context the iframe cannot forge;
- handles user confirmation;
- calls Surface with normal same-origin user credentials.

Surface action proxy:

- validates the frozen app version and declared action;
- checks user/workspace/channel access;
- validates payload schema;
- enforces idempotency and rate limits;
- writes audit rows;
- executes Atrium-native actions directly or dispatches external actions to a
  credential-aware adapter/worker.

Centaur / iron-control:

- stores and refreshes outside-app credentials;
- models users/channels/execution contexts as principals;
- grants secrets or roles to those principals;
- syncs only the effective config needed by a proxy/worker;
- injects credentials on matching requests instead of exposing them to generated
  app code.

## Design Consequences

Do not add artifact app API keys.

Do not let artifact iframes call Centaur or iron-control directly.

Do not relax the static app CSP into general network access as the first bridge.
Generated apps that can call arbitrary URLs are too hard to reason about and too
easy to turn into data-exfiltration tools.

Do add a typed app action layer where the generated app says "perform this named
operation with this validated payload" and Surface decides whether that operation
is allowed for the viewer, app version, and workspace/channel.

## First Implementation Shape

The first code slice should freeze action declarations at publish time from
`atrium.app.json`. That creates the enforcement surface without yet executing
privileged work:

```jsonc
{
  "name": "member-tools",
  "kind": "static",
  "entry": "index.html",
  "actions": {
    "atrium.channel.add_member": {
      "title": "Add member to channel",
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

Later slices can add the browser `postMessage` bridge, the Surface action route,
confirmation UI, audit table, and one Atrium-native action before attempting any
external connector action.

## Open Design Point

External action execution may live in Surface for simple server-owned adapters,
or in a worker/proxy path when it needs iron-control effective config. The
important boundary is that generated app code never chooses or receives the
credential. It requests a typed action; trusted server-side code resolves the
principal and credential path.
