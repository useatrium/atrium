# ADR: Typed sync roots (data-class lanes for agent sandboxes)

- **Status:** Accepted (2026-06-22). Boundary enforced in code by the node-sync
  classifier (Centaur #72 P4: `classify_entry` / `partition_entries_by_lane`).
- **Context:** Atrium #72 + the agent-sync workstream
  (`notes/agent-sync-design.md`, `notes/session-record-projection-build-plan.md`).

## Context

An agent runs in a sandbox and touches many kinds of files: work-product
documents, the harness's own native state (`.codex`/`.claude`), the code
checkout, materialized profile config/skills, auth/credential files, caches,
and a read-only context tree. A node-side daemon observes the sandbox's
filesystem (the overlay upper) and ships changes to durable stores.

The failure mode we are ruling out: **mixing these classes.** If capture treats
everything it sees as a "user artifact," then `.codex/auth.json`,
`.claude/.credentials.json`, SSH keys, plugin caches, and harness transcripts
leak into the artifact ledger / Files UI / shared search — a security and a
data-model break. (This is exactly what P4 fixed: `capture_sweep` and
`harness_transcript_sweep` previously shared one unfiltered scan.)

## Decision

**Sync intent, not directory trees.** Every path the daemon sees is classified
into exactly one typed lane, each with a single owner and destination. Lanes
never mix; sensitive shapes are denied from all of them.

| Lane | What it holds | Owner / destination | Captured as a user artifact? |
|---|---|---|---|
| `artifact_root` | user / work-product files, including reserved shared/scratch prefixes | artifact ledger (S3 CAS + version chain) + Files UI | **yes** — this is the only lane that becomes artifacts |
| `harness_state_root` | Codex/Claude native exact-resume state (rollout JSONL, transcript sidepaths) | restricted harness-state store (`harness_transcripts`) | no — system resume state, not a product artifact, not the UI transcript |
| `repo_root` | code checkout | git owns history; optional WIP **patch** artifact for recovery (pure-read `git diff`, no refs) | no — never the whole tree into the ledger |
| `profile_bundle_root` | materialized config / skills / plugins from the session's profile snapshot | profile metadata / bundle entries | no — profile state, not user files |
| `/atrium` / `~/context` | read-only chat/session/search context projection | a **cache/materialization** of server-owned records | **never** — read-only, session-scoped, never swept for capture |

**Deny-by-default (all lanes):** `auth.json`, `.credentials.json`, any
`*credentials*` component, `*.pem`/`*.key` and known private-key names
(`id_rsa`, `id_ed25519`), `.netrc`, `.git-credentials`, and anything under
`.ssh/` or `.aws/` are dropped from *every* sweep. Credentials travel only via
the private encrypted credential store — never via files, artifacts,
transcripts, or profile bundles.

## Consequences / invariants

- The node-sync daemon **partitions** each overlay-upper scan by lane before
  feeding the sweeps: `capture_sweep` receives only `Artifact` entries,
  `harness_transcript_sweep` only `HarnessState` entries; `Denied` entries reach
  neither. (Centaur `runtime.rs::classify_entry` / `partition_entries_by_lane`.)
- Inside `artifact_root`, scope is still typed by server-owned canonical prefixes, not by
  arbitrary folder ACLs or a separate v1 `space_id`: `shared/global/...`,
  `shared/channels/<active-channel-id>/...`, future `shared/projects/<project-id>/...`
  after project objects/ACLs exist, and `scratch/<session-id>/...`. The landed resolver
  rejects project and non-active channel prefixes rather than trusting arbitrary ids. Session
  scratch is an artifact surface with a narrower ACL; it is not harness state and should be
  visible to authorized humans in the Files/artifacts UI.
- Agent-visible mount aliases (`~` for the active shared leaf, `~/scratch`, and optional
  `~/shared/...`) must resolve to canonical artifact paths before capture, writeback,
  hydration manifests, and `artifact_sync_state` updates. Alias paths must not create duplicate
  artifact chains.
- `/atrium` is mounted **read-only and per-session** (`/var/lib/centaur/atrium/<session>`
  → `/atrium`, renamed to `~/context` in flat-home mode), so it can never be a capture surface
  and can't leak one viewer's ACL-filtered context to another agent on the same node.
- The product transcript that humans/agents search is the **rendered, redacted
  `session_records` projection** — not raw harness JSONL. Raw JSONL stays a
  gated resume/forensics archive (`harness_transcripts`).
- Future work (Agent Profiles, Memory store, credential refresh-writeback) plugs
  into the same lane discipline rather than re-collapsing everything into
  `.codex`/`.claude` directory mirroring.

## References

- Centaur #72 P4 — typed-root leak fix + leak-prevention tests.
- `notes/agent-sync-design.md`, `notes/session-record-projection-build-plan.md`.
- Atrium issue [#72](https://github.com/gbasin/atrium/issues/72) (closed) +
  the neighboring profile/credentials/typed-lane design thread.
