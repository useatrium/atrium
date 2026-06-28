# All-readable artifact scopes plan

Status: scoped from current `master` on 2026-06-25.

## Current state

The shared workspace model is partially built:

- artifact identity is workspace/path based;
- bare paths canonicalize to `shared/channels/<active-channel-id>/...`;
- `scratch/foo` canonicalizes to `scratch/<session-id>/foo`;
- `shared/global/...` is accepted;
- `shared/channels/<active-channel-id>/...` is accepted;
- non-active channels and `shared/projects/...` are rejected;
- hydration/changefeed/listing queries are hardcoded to own scratch,
  `shared/global`, and active channel.

This gives the agent a sane active cwd, but it does not yet expose "everything I
am allowed to read" under `~/shared`.

## Target model

Keep one genuine filesystem tree. Do not introduce arbitrary folder ACLs.

Canonical scopes:

- `shared/global/...`
- `shared/channels/<channel-id>/...`
- `shared/projects/<project-id>/...` once projects are real product objects
- `scratch/<session-id>/...`

Agent-visible layout:

```text
~
  report.md                         # active shared leaf alias
  scratch/...                       # own session scratch
  shared/
    global/...
    channels/<channel-id>/...
    projects/<project-id>/...
```

Rules:

- Bare `~/foo` writes to the active shared leaf.
- Explicit `~/shared/...` reads any granted scope.
- Explicit writes require write access to that exact root.
- Agents cannot create first-layer scope dirs by `mkdir shared/channels/new`.
  Those roots are generated from Atrium product objects.
- Sibling session scratch is not readable through hydration. If humans need to
  inspect it, use GUI/artifact APIs with session access, not agent filesystem
  hydration.

## Build plan

### 1. Scope resolver

Add a server resolver that returns scope roots for a session/user:

- `activePrefix`
- `readableRoots`
- `writableRoots`
- display labels and scope kind

Likely files:

- `surface/server/src/artifact-scope.ts`
- `surface/server/src/artifact-path.ts`
- `surface/server/src/membership.ts`
- `surface/server/src/app.ts`

For v1, channels can use existing membership checks. Projects should remain
behind a product-model gate until Atrium has `projects` and project membership or
project/channel binding tables.

### 2. Replace hardcoded prefix filters

Update:

- `ArtifactLedger.sessionScope`
- `ArtifactLedger.changesSince`
- `ArtifactLedger.changedSince`
- raw serve and by-path lookup
- files listing
- conflict lookup and resolution
- sync-state canonicalization

All of these should accept the resolver output or a resolved artifact access
context instead of reconstructing active-channel/global/scratch filters locally.

### 3. API shape

Return scope metadata from artifact/file routes:

- `activePrefix`
- `readableRoots`
- `writableRoots`
- `canonicalPath`
- `displayPath`
- `scopeKind`
- `canWrite`

Keep old minimal fields where clients already consume them, but make new clients
scope-aware.

### 4. Files UI

Update `FilesSurface` to browse top-level groups:

- active root files first;
- `scratch`;
- `shared/global`;
- readable `shared/channels/<name-or-id>`;
- readable `shared/projects/<name-or-id>` when projects exist.

Show read-only/writeable state and canonical path. Avoid nested cards; this is a
file browser, not a dashboard.

### 5. Upload pinning

Uploads already auto-land as artifacts under the active channel. Finish the
message reference model by pinning the exact artifact version:

```ts
{ artifactId, seq, path }
```

Message rendering opens the pinned version for historical attachment views, while
Files opens latest. This preserves chat immutability while keeping the file
editable.

### 6. Conflict and provenance hardening

Fix conflict routes that assume a session-origin artifact. Upload artifacts can
have nullable session provenance; shared/project artifacts should resolve by
workspace/path plus requester context, not by session ownership.

Cover:

- stale base from non-active readable roots;
- delete-vs-edit in shared non-active scopes;
- binary immutable conflicts;
- ACL loss while a conflict exists;
- path aliases resolving to one canonical chain.

## Tests

Server:

- resolver returns active/global/all readable channels/own scratch;
- non-readable channel/project roots are invisible;
- explicit write to readable-but-not-writable root is denied;
- bare path and explicit active channel path share one canonical artifact;
- hydration/changefeed include all readable roots and exclude sibling scratch;
- upload pinned version remains stable after latest edit;
- conflict routes work for shared non-active roots.

Web:

- root groups render correctly;
- read-only roots disable edit/upload;
- canonical/display paths remain understandable;
- upload attachment opens pinned version.

E2E:

- user in two channels hydrates both readable channel roots;
- private channel does not appear;
- session scratch appears only for own session;
- upload is visible in active root and message attachment opens pinned seq.

## Risks

- Project ACLs are the largest unknown because projects are not yet a first-class
  product model in current master.
- Hydrating every readable channel can be too large in big workspaces. If needed,
  start with eager metadata and lazy materialization per root.
- Alias canonicalization must be tested hard: `foo.md` and
  `shared/channels/<active>/foo.md` must never create separate chains.

