-- Re-key artifact identity from (session_id, path) to (workspace_id, path) — the
-- "shared workspace" keystone. See notes/shared-workspace-build-spec.md (lane A) and
-- cas-ledger-build-plan.md §10.1. After this, artifacts are workspace-shared (two sessions
-- in one workspace co-edit the same chain) and OUTLIVE their originating session.
--
-- Coupled with the artifact-ledger.ts re-key (lane B): the old ON CONFLICT (session_id, path)
-- becomes ON CONFLICT (workspace_id, path). This migration + that code land together.
--
-- §8 decisions encoded here (confirm before a PROD apply; safe on dev/test where data is empty):
--   §8.1 collision rewrite  — namespace colliding non-scratch paths, never silent-merge
--   §8.2 session-cascade    — drop it: artifacts survive session GC (session_id -> SET NULL)
--   §8.3 channel_id         — keep as nullable provenance (FK -> SET NULL), not identity

-- 1. workspace_id: add, backfill from the session (every session carries workspace_id), enforce.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE artifacts a
  SET workspace_id = s.workspace_id
  FROM sessions s
  WHERE s.id = a.session_id AND a.workspace_id IS NULL;

-- 2. Collision rewrite (§8.1). Two sessions in one workspace may legitimately hold the same
--    non-scratch path today (each was its own silo). Before enforcing UNIQUE(workspace_id, path)
--    we namespace EVERY colliding non-scratch row under proj-<full-session-uuid>/ so no two rows
--    silently collapse onto one version chain. scratch/<session>/… paths already embed the
--    session id, so they never collide. Deterministic + lossless (relocates a path, never drops
--    a row); the full uuid (fixed length) keeps the rewritten paths provably unique. If any
--    collision survives (e.g. a pre-existing literal proj-<uuid>/ path), the UNIQUE add below
--    fails the whole migration — fail-loud, never silent-merge.
WITH dups AS (
  SELECT workspace_id, path
  FROM artifacts
  WHERE path NOT LIKE 'scratch/%'
  GROUP BY workspace_id, path
  HAVING count(*) > 1
)
UPDATE artifacts a
  SET path = 'proj-' || a.session_id::text || '/' || a.path
  FROM dups d
  WHERE a.workspace_id = d.workspace_id AND a.path = d.path;

ALTER TABLE artifacts ALTER COLUMN workspace_id SET NOT NULL;

-- 3. Demote session_id / channel_id to nullable provenance; artifacts outlive both (§8.2/§8.3).
--    The real author is artifact_versions.author = 'agent:<session>' | 'human:<uid>'.
ALTER TABLE artifacts ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE artifacts ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE artifacts DROP CONSTRAINT artifacts_session_id_fkey;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE artifacts DROP CONSTRAINT artifacts_channel_id_fkey;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;

-- 4. Swap the identity key: (session_id, path) -> (workspace_id, path).
ALTER TABLE artifacts DROP CONSTRAINT artifacts_session_id_path_key;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_workspace_id_path_key UNIQUE (workspace_id, path);
-- Keep a non-unique (session_id, path) index for per-session "files I authored" views.
CREATE INDEX IF NOT EXISTS artifacts_session_path_idx ON artifacts (session_id, path);

-- 5. Change-feed: denormalize workspace_id + add the workspace egress-poll cursor index.
--    session_id goes nullable here too (a change row can outlive its session like the artifact).
ALTER TABLE artifact_changes ADD COLUMN IF NOT EXISTS workspace_id uuid;
UPDATE artifact_changes c
  SET workspace_id = a.workspace_id
  FROM artifacts a
  WHERE a.id = c.artifact_id AND c.workspace_id IS NULL;
ALTER TABLE artifact_changes ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE artifact_changes DROP CONSTRAINT artifact_changes_session_id_fkey;
ALTER TABLE artifact_changes ADD CONSTRAINT artifact_changes_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS artifact_changes_workspace_cursor_idx
  ON artifact_changes (workspace_id, xid, id);

-- Re-emit the change-feed row with workspace_id denormalized off the artifact. session_id/path
-- stay denormalized for per-session views + echo attribution. origin still rides the txn GUC.
CREATE OR REPLACE FUNCTION artifact_changes_emit() RETURNS trigger AS $$
DECLARE
  a_workspace uuid;
  a_session   uuid;
  a_path      text;
BEGIN
  SELECT workspace_id, session_id, path
    INTO a_workspace, a_session, a_path
    FROM artifacts WHERE id = NEW.artifact_id;
  INSERT INTO artifact_changes
    (artifact_id, workspace_id, session_id, path, seq, base_seq, sha, status, kind, author, origin)
  VALUES
    (NEW.artifact_id, a_workspace, a_session, a_path, NEW.seq, NEW.base_seq, NEW.blob_sha,
     NEW.status, NEW.kind, NEW.author,
     COALESCE(NULLIF(current_setting('atrium.change_origin', true), ''), 'agent'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
