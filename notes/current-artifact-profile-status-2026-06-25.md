# Current artifact/profile status, 2026-06-25

This note captures the post-rollout state checked against Atrium `master` and
Centaur `main` after the harness profile/config sync work completed.

## Harness/profile sync

Status: mostly fixed for sanitized Codex and Claude config proposal review.

Landed Atrium commits:

- `9556736` `Add agent profile writeback`
- `8b42bf0` `Resolve internal session refs by thread key`
- `de58b3d` `Surface Codex auth reconnect state`

Landed Centaur commits:

- `cab014d` `Capture sanitized agent profile candidates`
- `b7e968e` `Route node sync through Atrium session ids`

What exists now:

- Atrium stores profile versions, session proposals, review actions, and profile
  overlays for Codex and Claude.
- Centaur scans `.codex` and `.claude` harness homes for sanitized candidate
  config/settings data and excludes credential-shaped paths before reading.
- Atrium session spawn can bind selected profile ids and inject overlay env into
  execution.
- Centaur node-sync manifests carry both the local Centaur session id and the
  Atrium session id; the daemon uses `atrium_session` for Atrium internal HTTP.

Coverage:

- Atrium server: `surface/server/test/agentProfiles.test.ts` covers proposal
  ingest, redaction, legacy payload normalization, wrong-harness rejection,
  private channel access checks, proposal actions, stale profile save rejection,
  safe bundle metadata, and credential-shaped path rejection.
- Atrium sessions: `surface/server/test/sessions.test.ts` covers profile binding
  and overlay injection plus Codex auth reconnect state.
- Atrium web/e2e: `surface/web/test/spawnDialog.test.tsx` covers profile ids from
  spawn UI; `surface/e2e/tests/agent-profiles.spec.ts` covers review applying
  session lineage.
- Centaur: `profile_candidates.rs`, `runtime.rs`, `session_manifest.rs`,
  `http_client.rs`, and k8s overlay tests cover candidate extraction, denied
  paths, Atrium-session routing, and `--atrium-session` provisioning.

Remaining profile/routing gaps:

- Atrium `harness-transcript` accepts UUID or `centaur_thread_key` through
  `resolveInternalSessionRef`; `profile-candidates` currently passes `:id`
  directly into profile proposal ingest. This is acceptable because Centaur now
  sends the Atrium UUID, but the two internal routes are asymmetric.
- No cross-repo e2e proves a real provisioned Centaur sandbox posts profile
  candidates all the way into Atrium.
- Current proposal support is sanitized config/settings, not the full older plan
  scope for skills/plugins/commands/agents bundles.
- Coverage proves overlay env injection, but not a live cold-start/resume where
  saved profile config is materialized into `.codex/config.toml` or Claude config
  in a fresh sandbox.

## Artifact baseline

Status: workspace-scoped artifacts and single-CAS writes are built, but broader
read scope and media-aware UX are not done.

Current behavior:

- Ledger identity is workspace/path based.
- Fresh non-delete artifact versions require durable Atrium CAS/S3 bytes before
  commit.
- Uploads auto-land as artifacts under `shared/channels/<active>/uploads`.
- Hydration/changefeed covers `shared/global`, active channel, and own
  `scratch/<session-id>`.
- `shared/projects` and all-readable channels are not first-class read roots.
- `FilesSurface` still treats content as text and decodes responses with
  `response.text()`.

Without WIP/scratch retention:

- Current blob GC only deletes CAS blobs that no `artifact_blob_refs` row
  references after the grace window.
- Session scratch and WIP-like artifact versions remain referenced by normal
  ledger rows, so CAS blob GC will not reclaim them.
- Practically, old session scratch and uncommitted-WIP snapshots accumulate until
  explicit artifact/version retention exists. This is a storage growth issue, not
  a conflict issue: scratch paths are session-scoped, and two agents in the same
  repo do not share WIP artifacts unless a human deliberately promotes or copies
  them into `shared/...`.
- Resumed sessions can still recover their own scratch/WIP because the referenced
  artifact versions remain in the ledger. Sibling sessions cannot hydrate another
  session's scratch by default.

## Recommended remaining lanes

1. WIP/scratch retention and GC: 30-day default history for session-scoped WIP
   artifacts, with pinned/latest/safety exclusions.
2. All-readable artifact scopes: resolver-driven `shared/global`, readable
   channels, future readable projects, and own scratch.
3. Media classification, binary safety, derived text, and search.
4. Static artifact apps.
5. Linux/cluster validation remains tabled here because another agent was
   validating it.

