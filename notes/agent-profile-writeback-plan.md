# Agent Profile Writeback Build Plan

Status: draft plan, revised 2026-06-25 after comparison with the 2026-06-21
Boundary+ADR scope

Related:

- `notes/adr-typed-sync-roots.md`
- `notes/harness-resume-build-plan.md`
- `notes/harness-resume-workstream.md`
- GitHub issue 97: Track profile/config writeback for Codex and Claude harness profiles
- Historical scope:
  `/Users/garybasin/.codex/sessions/2026/06/21/rollout-2026-06-21T13-02-10-019eeb21-f100-7642-a86b-e341fb245700.jsonl`

## Goal

Add reviewable Agent Profile writeback for Codex and Claude Code without
mirroring `.codex` or `.claude` directories.

A session may produce provider config changes. Atrium should detect the safe,
portable parts, show a human-reviewable proposal, and let the user choose:

- discard
- apply to this session/resume lineage
- save to the current profile
- save as a new profile

The system must preserve the existing typed-lane invariants:

- artifacts are user work product
- harness state is exact-resume state
- profile bundles are user-selected config/customization state
- credentials never travel through artifacts, transcripts, or profile bundles

Before building profile writeback, two adjacent lanes must be real enough to keep
the profile lane honest:

- session-scoped harness-state bundles for exact resume, including required
  sidepaths beyond the main JSONL
- private encrypted credential refresh writeback for subscription auth, separate
  from profiles and artifacts

## Current State

Atrium already has encrypted provider credentials for Codex and Claude Code.
Centaur materializes provider config at sandbox startup:

- Codex: writes `.codex/auth.json`, then writes/patches `.codex/config.toml`
- Claude Code: writes `.claude/settings.json`, and in subscription mode writes
  `.claude/.credentials.json`
- Resume: restores only the main harness transcript JSONL to the deterministic
  Codex/Claude path

Centaur node-sync currently partitions overlay entries into:

- `Artifact`
- `HarnessState`
- `Denied`

`.codex` and `.claude` are routed to `HarnessState`; credential-shaped paths are
denied first; only the located transcript is uploaded from harness state.
Therefore config edits in `.codex` or `.claude` are currently ignored and are
lost on a fresh cold start.

The older 2026-06-21 "Boundary+ADR" scope was a prerequisite slice, not the full
profile product. Current repos show that most of that slice exists:

- Atrium has `notes/adr-typed-sync-roots.md` defining artifacts, harness state,
  profile bundles, credentials, and memory as separate ownership lanes.
- Centaur node-sync partitions entries into `Artifact`, `HarnessState`, and
  `Denied`.
- Centaur tests keep `.codex`, `.claude`, `auth.json`, `.credentials.json`,
  `.ssh`, `.aws`, `.git`, and top-level dotfile roots out of artifact capture.
- Centaur daemon/chart wiring now supports `--overlays-root` multi-session mode,
  so the old env-vs-flag concern is no longer the primary blocker.

What changed since that scope: profile writeback can now build on the lane
boundary work, but credential refresh and broader harness-state bundling are
promoted to prerequisites for this build.

## Decisions

Confirmed decisions:

- Create a new focused plan file rather than expanding the typed-sync ADR.
- Build Codex and Claude Code support in the same effort.
- Before implementation, validate risky harness behavior with isolated live CLI
  probes.
- Implementation work must wait until the current dirty hardcut work settles, then
  happen in a separate worktree based on clean remotes.
- Use agent fanout where it buys real parallelism.
- Require full E2E coverage for the feature surface.
- Review all code with review agents before merging.
- Merge back to main/master only after CI is green.
- Include private credential refresh writeback in this build.
- Treat session-scoped harness-state sidepath/subagent transcript bundling as a
  prerequisite to profile writeback.
- Include skills/plugins/commands/agents bundles in V0 profile support.
- Add local full profile import for safe config plus bundles.
- Keep local Codex/Claude transcript/history import separate and later.

Conservative defaults to revisit if needed:

- V0 blocks MCP configs containing literal secret values. It can save the
  non-secret shape, but users must replace literals with env vars or credential
  refs before applying.
- V0 excludes project/local Claude Code config from reusable user profiles.
  Path-keyed project config is session/project state unless a later product flow
  explicitly promotes it.
- V0 excludes local transcript/history import.

## Live Harness POC Findings

POCs were run under `.poc-stress-test/` with isolated `CODEX_HOME`, `HOME`, and
`CLAUDE_CONFIG_DIR`; no model calls were made.

Installed harness versions:

- Codex CLI: `0.142.2`
- Claude Code: `2.1.191`

Findings:

1. `codex mcp add` writes global MCP config into `$CODEX_HOME/config.toml`.
   HTTP MCP entries store `bearer_token_env_var` safely by env var name, but
   stdio MCP entries can persist literal env values:

   ```toml
   [mcp_servers.poc-stdio.env]
   POC_SECRET = "<redacted>"
   ```

2. `claude mcp add -s user` writes MCP config into
   `$CLAUDE_CONFIG_DIR/.claude.json`, not `settings.json`. That file also
   contains machine/user/cache fields such as `machineID`, `userID`,
   `firstStartTime`, and migration flags. User-scope MCP entries can persist
   literal headers and env values.

3. `claude mcp add` with local/default scope writes into
   `$CLAUDE_CONFIG_DIR/.claude.json.projects[<project-root>]`. In the POC, the
   key resolved to the repo root. This is not portable profile state.

4. `claude plugin init` scaffolds bundles under
   `$CLAUDE_CONFIG_DIR/skills/<plugin>/`, including plugin manifest, MCP config,
   hooks, agents, and skills. Because bundles are in V0, the implementation must
   include file-size limits, executable-code review, denied-path filtering, and
   materialization semantics from the start.

## Non-Goals

- Do not mirror `.codex` or `.claude`.
- Do not store `auth.json`, `.credentials.json`, OAuth account state, keychain
  material, API keys, bearer headers, private keys, or credential-shaped paths
  in profile bundles.
- Do not move exact-resume transcript capture into profile storage.
- Do not treat Claude project/local path maps as portable user profile data in
  V0.
- Do not import local Codex/Claude transcripts/history into Atrium as part of
  profile import. That is a later history/search migration feature.
- Do not automatically let an agent save its own profile changes without a
  human/API review step.
- Do not solve general Memory product behavior in this feature.

## V0 Allowlist

### Codex

Structured config candidates:

- `$CODEX_HOME/config.toml`
- `$CODEX_HOME/*.config.toml`

Allowed parsed sections/keys:

- model and reasoning preferences
- approval/sandbox preferences, subject to Atrium/Centaur policy ceilings
- feature flags
- MCP server definitions after secret scanning
- hooks config after trust review
- rule references and non-secret rule files
- profile-layer config files
- `AGENTS.md` as a user instruction file, with explicit review
- skills/plugins/commands/agents bundles with manifest, size, executable-code,
  and denied-path checks

Excluded:

- `auth.json`
- `sessions/**`
- `history.jsonl`
- `session_index.jsonl`
- SQLite state/log/memory DBs
- logs, caches, temp dirs, shell snapshots, process/browser/node state
- generated images and large generated assets
- any path or value matching credential/key/token patterns

### Claude Code

Structured config candidates:

- `$CLAUDE_CONFIG_DIR/settings.json`
- selected subtrees from `$CLAUDE_CONFIG_DIR/.claude.json`

Allowed parsed sections/keys:

- user-level MCP server definitions after secret scanning
- selected settings such as permissions, model/effort/view preferences, plugin
  enablement, marketplaces, hooks, and non-secret preferences
- agents/commands/skills/plugins bundles with manifest, size, executable-code,
  and denied-path checks

Excluded:

- `.credentials.json`
- daemon control keys
- MCP auth caches
- OAuth/account/machine identifiers
- `projects/**/*.jsonl`
- `tasks/**`, `session-env/**`, `file-history/**`
- telemetry, debug, cache, history, shell snapshots
- project/local `.claude.json.projects[...]` config in reusable profiles
- any path or value matching credential/key/token patterns

## Architecture

### Prerequisite: Harness-State Bundle

The current `harness_transcripts` lane stores one main JSONL snapshot per
session/harness. This is enough for the proven main-thread resume path, but the
profile build should not advance until harness state has an explicit bundle
shape for any required sidepaths.

Bundle requirements:

- session-scoped, not profile-scoped
- not visible as artifacts
- credential deny rules applied before upload
- main transcript retained as the fast/compatibility path
- bundle manifest records provider, adapter version, file hashes, logical role,
  and restore path
- supports Codex and Claude Code sidepaths needed for exact resume, including
  subagent/tool-result transcript paths when verified

Prefer adding a new internal bundle endpoint while keeping the current main
transcript endpoint for compatibility:

```text
PUT /api/internal/sessions/:id/harness-state-bundle?harness=<claude|codex>
GET /api/internal/sessions/:id/harness-state-bundle?harness=<claude|codex>
```

The existing transcript endpoint can continue serving clients that only need the
main JSONL.

### Prerequisite: Credential Refresh Writeback

Subscription auth can refresh inside the sandbox. Those refreshed credentials
must flow back only through Atrium's encrypted provider credential store.

Rules:

- never profile-sync `auth.json`, `.credentials.json`, OAuth caches, bearer
  tokens, refresh tokens, API keys, or keychain/account material
- deny credential-shaped files from artifact, harness-state bundle, and profile
  bundle lanes
- capture refresh candidates through a private credential-refresh adapter
- validate provider-specific credential shape server-side before updating the
  encrypted store
- emit auditable metadata such as provider, session, old/new hash, and refresh
  time, but never raw secret values in logs/events
- if refresh validation fails, leave the existing credential untouched and mark
  the user/provider auth state as needing reconnect

Suggested internal endpoint:

```text
PUT /api/internal/sessions/:id/provider-credential-refresh?harness=<claude|codex>
Content-Type: application/json
```

This endpoint is a credential-store write, not a profile proposal.

### Centaur: Profile Candidate Sweep

Add a `profile_candidate_sweep` next to `harness_transcript_sweep`.

Inputs:

- partitioned `HarnessState` entries
- harness kind
- harness home
- current session id / thread key
- profile baseline metadata, if present

Output:

- redacted structured proposal payload
- adapter version
- source file hashes
- excluded path/value reasons
- warning list

The sweep should run after transcript capture. It must never send raw
credential-bearing bytes to persistent storage. Prefer extracting/redacting in
Centaur before uploading to Atrium, with Atrium re-validating the proposal shape
server-side.

New internal endpoint shape:

```text
PUT /api/internal/sessions/:id/profile-candidates?harness=<claude|codex>
Content-Type: application/json
```

The endpoint stores a proposal, not a profile version. It is last-write-wins per
session/harness/baseline unless content hash changes warrant keeping history for
audit.

### Atrium: Storage

Add immutable profile/version tables plus proposal tables.

Suggested tables:

- `agent_profiles`
  - `id`
  - `user_id`
  - `provider` (`codex` or `claude-code`)
  - `name`
  - `current_version_id`
  - timestamps
- `agent_profile_versions`
  - `id`
  - `profile_id`
  - `provider`
  - `adapter_version`
  - `manifest_json`
  - `content_hash`
  - `created_by`
  - timestamps
- `session_profile_snapshots`
  - `session_id`
  - `provider`
  - `profile_version_id`
  - `adapter_version`
  - `baseline_hash`
  - `baseline_manifest_json`
- `session_profile_change_proposals`
  - `id`
  - `session_id`
  - `provider`
  - `base_profile_version_id`
  - `adapter_version`
  - `proposal_json`
  - `risk_summary_json`
  - `status` (`pending`, `discarded`, `applied_to_lineage`, `saved_profile`)
  - timestamps

Bundle file contents should use existing CAS/blob infrastructure. Structured
settings can live as JSON manifests; bundle manifests reference CAS objects by
hash/path/role.

### Atrium: APIs

User-facing API:

```text
GET  /api/sessions/:id/profile-change-proposals
POST /api/sessions/:id/profile-change-proposals/:proposalId/discard
POST /api/sessions/:id/profile-change-proposals/:proposalId/apply-lineage
POST /api/sessions/:id/profile-change-proposals/:proposalId/save-current-profile
POST /api/sessions/:id/profile-change-proposals/:proposalId/save-new-profile

GET  /api/me/agent-profiles
POST /api/me/agent-profiles
GET  /api/me/agent-profiles/:id
POST /api/me/agent-profiles/:id/versions

POST /api/me/agent-profiles/import-local
```

Spawn/session API additions:

- optional `agentProfileId`
- optional `agentProfileVersionId`
- selected profile snapshot is bound to the session at spawn time

Local profile import:

- reads local safe config plus bundles
- excludes credentials, transcripts, history, caches, logs, file-history, tasks,
  and daemon/runtime state
- runs the same provider adapters and review UI as session proposals
- creates a pending import proposal first, not an immediate saved profile

### Materialization

V0 should materialize structured config through existing Centaur overlay hooks:

- Codex: generate `CODEX_CONFIG_OVERLAY` from the selected profile version
- Claude Code: generate `CLAUDE_SETTINGS_OVERLAY` from selected profile settings

For Claude Code user-scope MCP from `.claude.json`, V0 needs one of:

- extend the entrypoint with a `CLAUDE_USER_CONFIG_OVERLAY` merge into
  `$CLAUDE_CONFIG_DIR/.claude.json`
- or materialize a generated profile config file through a new Centaur profile
  payload before the harness starts

Prefer the explicit Centaur profile payload if it will also support bundles in
the next phase.

Bundle materialization should happen after baked config is copied and before
auth/resume starts. It must not overwrite denied credential paths.

## UI

Add a profile-changes surface near session state, not in the artifact file UI.

The UI should show:

- provider
- source session
- changed settings grouped by provider section
- risk labels (`safe`, `needs-secret-ref`, `policy-capped`, `unsupported`)
- excluded paths/counts with reasons
- actions: discard, apply to lineage, save current profile, save as new profile

Do not render profile proposals as artifacts. They are system/profile state.

## Security Rules

The adapter must reject or block:

- path components containing `credentials`
- `auth.json`, `.credentials.json`, `.netrc`, `.git-credentials`
- private key names and `*.pem` / `*.key`
- `.ssh/**`, `.aws/**`, `.git/**`
- keys/values containing likely token, bearer, API key, secret, password, OAuth,
  refresh-token, or private-key content

For MCP:

- env var names are allowed
- literal env/header secret values are blocked in V0
- command and args are reviewable because they are executable behavior
- OAuth/client-secret flows must store secrets only through the encrypted
  credential store, not profile manifests

Policy ceilings:

- profile materialization may request approval/sandbox/tool permissions, but
  Atrium/Centaur deployment policy wins
- saved profiles must not bypass managed/admin restrictions

## Hand-Computed Flow

Current broken flow:

```text
t0 Atrium session has provider credential, no profile snapshot
   Atrium = { providerSecret: encrypted, profileVersion: null }
   Centaur = { harnessHome: empty }

t1 entrypoint writes fresh harness config/auth
   Codex = { config.toml: baked+env overlay, auth.json: injected }
   Claude = { settings.json: baked+env overlay, credentials: injected if needed }

t2 agent edits config
   harnessHome = { config/settings changed, transcript changed, caches changed }

t3 node-sync partitions
   .codex/.claude config -> HarnessState
   auth/credential paths -> Denied
   transcript -> HarnessState

t4 harness_transcript_sweep uploads only transcript
   Atrium = { harnessTranscript updated, profileProposal: none }

t5 fresh resume/start repeats entrypoint
   config edit is gone
```

Fixed V0 flow:

```text
t0 session starts with optional profile version
   Atrium = { profileVersion: Vn, credential: encrypted }

t1 entrypoint materializes baked config + profile overlay + auth
   session_profile_snapshots records baseline hash

t2 agent edits allowed config/MCP
   harnessHome = { changed config plus transcript/caches }

t3 node-sync partitions
   profile_candidate_sweep inspects harness entries with provider adapter
   denied paths/secret values are excluded before proposal persistence

t4 Atrium stores pending proposal
   profile version unchanged
   session lineage unchanged unless user applies it

t5 user reviews
   discard -> no future effect
   apply-lineage -> future resumes in this session get overlay
   save-current/save-new -> immutable profile version created
```

## Implementation Phases

### Phase 0: Base Stabilization

- Do not start implementation from the current dirty hardcut worktrees.
- Wait for the current hardcut work to land or be explicitly abandoned.
- Create fresh worktrees from clean remotes for Atrium and Centaur.
- Re-check current Centaur fork/main vs origin/main before coding.

### Phase 1: Harness-State And Credential Prerequisites

- Evolve harness transcript storage into a session-scoped harness-state bundle.
- Keep current main-transcript restore working.
- Add sidepath discovery/restoration for Codex and Claude exact resume.
- Add tests proving sidepaths are session state, not artifacts or profiles.
- Add encrypted credential-refresh writeback endpoint and provider adapters.
- Add tests proving refreshed credentials never enter artifacts, harness-state
  bundles, profile proposals, logs, or events.

### Phase 2: Foundations

- Add Atrium migrations for profiles, versions, snapshots, and proposals.
- Add shared provider/profile JSON schemas in `surface/shared`.
- Add server-side validation and secret scanning for proposal payloads.
- Add internal proposal ingest endpoint.
- Add unit tests for storage, validation, and credential rejection.

### Phase 3: Centaur Structured And Bundle Adapters

- Add Codex adapter:
  - parse TOML
  - allowlist config sections
  - detect MCP env literal secret values
  - capture allowed bundles with manifest and CAS references
  - emit redacted proposal
- Add Claude adapter:
  - parse `settings.json`
  - extract user-scope `.claude.json.mcpServers`
  - exclude `.claude.json.projects`
  - detect MCP header/env literal secret values
  - capture allowed bundles with manifest and CAS references
  - emit redacted proposal
- Wire `profile_candidate_sweep` after `harness_transcript_sweep`.
- Add Rust tests for classification, extraction, denied paths, and redaction.

### Phase 4: Review, Import, And Profile APIs

- Add user-facing proposal list/actions.
- Add profile CRUD/version APIs.
- Add local profile import API for safe config plus bundles.
- Add session spawn profile selection.
- Bind selected profile version into `session_profile_snapshots`.
- Add tests for apply-lineage and save-current/save-new.

### Phase 5: Materialization

- Generate Codex profile overlay.
- Generate Claude settings/user-config overlay.
- Materialize allowed bundles from profile CAS references.
- Wire Centaur sandbox startup to apply selected profile version before first
  harness turn.
- Add integration tests proving a saved setting appears in the next session
  while denied credentials do not.

### Phase 6: UI and E2E

- Add profile selector to spawn flow.
- Add profile proposal review UI.
- Add local profile import review UI.
- Add E2E coverage:
  - Codex config/MCP proposal appears after a session mutation
  - Claude settings/MCP proposal appears after a session mutation
  - literal MCP secret is blocked and shown as needing user action
  - Codex and Claude bundle changes are captured, reviewed, saved, and
    materialized
  - save-as-new profile affects a new session
  - apply-lineage affects resume lineage but not global profile
  - denied paths never appear in artifacts or profile proposals
  - refreshed subscription credentials update only the encrypted credential store
  - harness-state sidepaths restore exact resume without becoming profile state

### Phase 7: Transcript Import Follow-Up

- Design local transcript/history import as a separate feature.
- Decide whether it is search-only historical import or session reconstruction.
- Keep it out of Agent Profile storage.

## Test Matrix

Atrium server:

- harness-state bundle storage and restore
- credential refresh validation and encrypted-store update
- migration tests
- profile/version CRUD
- local profile import proposal creation
- proposal ingest validation
- proposal action transitions
- secret rejection
- profile snapshot binding

Centaur:

- path classification remains unchanged for artifacts/harness/denied
- Codex TOML extraction/redaction
- Claude JSON extraction/redaction
- MCP literal-secret blocking
- transcript capture remains independent from profile proposal capture
- harness-state sidepaths are captured/restored without entering profile or
  artifact lanes
- credential refresh candidates route only to the credential lane
- bundle capture/materialization honors size, manifest, executable review, and
  denied-path rules

Web:

- profile picker
- proposal review surface
- local import review surface
- risk labels and disabled actions for unresolved secrets

E2E:

- credential refresh writeback
- harness-state bundle exact resume with sidepaths
- spawn with profile
- mutate config
- capture proposal
- import local config plus bundles into a reviewed profile proposal
- save profile
- spawn/resume with saved profile
- verify denied paths are absent from artifacts and proposals

## Delivery Gates

Before merging:

- work is built in a separate worktree
- base remotes are clean/stabilized before implementation starts
- harness-state bundle prerequisite passes
- credential refresh writeback prerequisite passes
- fanout work is integrated with a single final review pass
- full unit/integration/E2E coverage for V0 is present
- review agents inspect Atrium changes, Centaur changes, and security-sensitive
  adapter logic
- local test suite for touched packages passes
- CI is green
- no `.poc-stress-test/` artifacts remain

## Open Risks

- Claude Code stores user-scope MCP in `.claude.json`, which also carries
  machine/user/cache data. Adapter mistakes here can leak non-portable state.
- Both providers allow executable customization through MCP commands/hooks.
  Review UI needs to make executable behavior visible.
- Existing Centaur config overlays cover `config.toml` and `settings.json`, but
  Claude user-scope MCP needs a new materialization path.
- Bundle support is in V0 now, which increases security and UX review cost:
  bundles can contain executable hooks, MCP definitions, and prompts.
- Exact resume sidepath capture is now a prerequisite. It may require
  provider-version-specific discovery logic and runtime POCs.
- Credential refresh writeback is now in scope. A bad implementation risks
  credential loss or secret leakage, so it needs stronger test/review gates than
  ordinary profile config.
- Local transcript/history import is separate later. Full profile import does
  not upsert native local transcripts into Atrium sessions.
