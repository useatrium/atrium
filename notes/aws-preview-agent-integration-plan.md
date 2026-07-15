# AWS Preview Agent Integration Plan

Date: 2026-07-15

## Goal

Let a production Atrium agent deploy a pushed Atrium branch to an isolated AWS preview and return the ready URL to the user.

The agent should not receive AWS credentials. Production Atrium should call a narrow preview launcher API that owns AWS access.

## Orientation For A Future Atrium Agent

Start here if you are reviewing this branch to decide how production Atrium agents should create previews.

Relevant files:

- `deploy/preview/aws/README.md`: operator-facing overview of the AWS preview appliance and launcher API.
- `deploy/preview/aws/launcher.py`: small bearer-token HTTP API for create/status/destroy.
- `deploy/preview/aws/previewctl.py`: local AWS controller that creates EC2, S3, ECR, IAM, Surface, Centaur, Caddy, and cleanup state.
- `deploy/preview/aws/launcher-box.md`: current launcher box shape, restart commands, cost, and IAM notes.
- `notes/gallery-request-fanout-preview-deploy.md`: real deploy timing, problems found during live testing, and speed improvement observations.
- This file: production-agent integration context and open design options.

What has been proven:

- A branch can be deployed through the launcher to an isolated AWS preview.
- Surface and Centaur can both run in the preview appliance.
- The preview can return a final HTTPS `sslip.io` URL.
- Agent execution worked well enough for smoke checks in the preview.
- Preview app-origin routing and S3 file-preview CORS both needed specific preview wiring and are now captured in the generator.

What is not settled:

- The best production-Atrium integration point for the launcher.
- Whether the agent should call an Atrium server-side wrapper, a Centaur tool, or another connector path.
- How preview status should appear in the Atrium UI.
- How production should authorize users/agents to create or destroy previews.
- How aggressive to be on speed work before the first production-agent integration.

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

## Production Atrium Integration Options To Evaluate

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

### Other Options To Consider

There may be additional integration points in Atrium or Centaur that are a better fit than either option above. A reviewing agent should inspect the current production agent/tool architecture before choosing.

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

## Candidate Engineering Tasks

- Verify launcher status returns the final HTTPS `ready.json.url`, not the initial EC2 HTTP URL.
- Decide whether production needs a server wrapper endpoint, a Centaur connector/tool, or another integration path.
- Add whatever network ingress is required for the selected production integration path to reach the launcher.
- Add agent prompt/tool guidance: push branch first, then request preview, then poll.
- Add status-card rendering in Atrium once the API shape is stable.
- Add manual and automated destroy paths.

## Questions Allan Can Answer

- Should preview creation be available to all production agents/users or only specific users?
- Should previews remain public URLs for now, or should they require an auth gate?
- Should a production agent be allowed to destroy previews automatically?
- Is a chat/status card enough for V1, or should previews have a first-class UI surface?
- Is a 10-15 minute first deploy acceptable for V1 if subsequent work improves speed?

## Speed Follow-Ups

The first successful branch preview took about 14 minutes 28 seconds. Highest-value speedups:

- Create a reusable AMI with Docker, k3s, Helm, `just`, AWS CLI, and common base images preinstalled.
- Cache/prebuild the Surface image by commit, similar to the Centaur ECR cache.
- Cache by service/source hash rather than only commit SHA so unchanged services can be reused across branches.
- Add Rust/BuildKit cache persistence for Centaur service misses.
- Return phase durations directly from the launcher API.
