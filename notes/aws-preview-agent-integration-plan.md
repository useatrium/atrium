# AWS Preview Agent Integration Plan

Date: 2026-07-15

## Goal

Let a production Atrium agent deploy a pushed Atrium branch to an isolated AWS preview and return the ready URL to the user.

The agent should not receive AWS credentials. Production Atrium should call a narrow preview launcher API that owns AWS access.

## Current Preview Launcher Contract

Launcher endpoint:

```http
POST /previews
Authorization: Bearer <launcher token>
Content-Type: application/json

{
  "repo": "useatrium/atrium",
  "ref": "feature/example-branch",
  "ttl_hours": 24,
  "requested_by": "@agent"
}
```

Status endpoint:

```http
GET /previews/<preview_id>
Authorization: Bearer <launcher token>
```

Destroy endpoint:

```http
DELETE /previews/<preview_id>
Authorization: Bearer <launcher token>
```

The launcher resolves the branch/ref to an immutable commit SHA before deployment. The preview URL maps to that commit, not to a mutable branch head after the fact.

## Agent-Facing Workflow

1. Agent makes or checks out a branch.
2. Agent commits and pushes the branch to `useatrium/atrium`.
3. Agent calls the preview launcher with `{ repo, ref, ttl_hours, requested_by }`.
4. Agent polls status until:
   - `status=ready`: post URL, commit SHA, expiry, and any test instructions.
   - `status=failed`: post failure phase/message and relevant logs if available.
   - timeout: post preview id and current phase so a human can continue.
5. Agent should offer to destroy the preview when the user is done.

## Production Atrium Integration Options

### Option A: Server-Side Preview Tool Endpoint

Production Atrium adds a server endpoint that wraps the launcher:

- `POST /api/tools/previews`
- `GET /api/tools/previews/:id`
- `DELETE /api/tools/previews/:id`

The production server stores `PREVIEW_LAUNCHER_URL` and `PREVIEW_LAUNCHER_TOKEN`, and agents use an Atrium internal tool instead of direct network access.

Pros:

- Best secret isolation.
- Auditable by Atrium.
- Allows per-user/team policy later.
- Easiest to render preview status cards in chat.

Cons:

- Requires Atrium server changes.

### Option B: Agent Connector Tool

Expose a tool directly to the agent runtime that calls the launcher.

Pros:

- Fastest to wire if Centaur/tool delivery supports it.
- Minimal Atrium UI/server change.

Cons:

- Harder to audit in Atrium.
- Tool availability depends on agent runtime configuration.
- More care needed to avoid leaking launcher URL/token into transcript/logs.

### Recommendation

Use Option A. Production Atrium should be the policy and audit boundary, while the launcher remains the AWS credential boundary.

## Chat UX

For a user request like:

> Deploy this branch as a preview.

The agent response should show:

- branch/ref
- resolved commit SHA
- preview id
- current status/phase while bootstrapping
- final URL when ready
- expiry time
- destroy action or instruction

For long deploys, update the same work/status surface instead of posting noisy repeated messages.

## Security Notes

- Launcher token must live only in production server configuration or a server-side secret manager.
- Agents should never print the token or AWS keys.
- Previews are currently public URLs; do not seed production data.
- Each preview gets its own S3 bucket, per-preview IAM user, database volume, generated app/session secrets, and TTL tag.
- The launcher should remain allowlisted to `useatrium/atrium` until there is a broader trust model.

## Immediate Engineering Tasks

- Make launcher status return the final HTTPS `ready.json.url`, not the initial EC2 HTTP URL.
- Add a production-server wrapper endpoint or internal tool definition.
- Add launcher ingress from production Atrium to the launcher box security group.
- Add agent prompt/tool guidance: push branch first, then request preview, then poll.
- Add status-card rendering in Atrium once the API shape is stable.
- Add manual and automated destroy paths.

## Speed Follow-Ups

The first successful branch preview took about 14 minutes 28 seconds. Highest-value speedups:

- Create a reusable AMI with Docker, k3s, Helm, `just`, AWS CLI, and common base images preinstalled.
- Cache/prebuild the Surface image by commit, similar to the Centaur ECR cache.
- Cache by service/source hash rather than only commit SHA so unchanged services can be reused across branches.
- Add Rust/BuildKit cache persistence for Centaur service misses.
- Return phase durations directly from the launcher API.
