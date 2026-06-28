-- C1 inbound-sync source: a durable, egress-pollable, GAP-FREE change-feed over
-- artifact version commits, plus the per-path sync-state record (the "one root"
-- fix from docs/archive/notes/agent-sync-design.md §8A takeaway #1 / §8B #2).
--
-- WHY an outbox + a transaction-id watermark (not a naive max(id) cursor):
--   A bigserial id is allocated at INSERT but only becomes visible at COMMIT, so
--   a slow concurrent txn can make a LOWER id appear in the table AFTER a higher
--   id was already consumed. A consumer that watermarks on max(id) silently drops
--   that row forever (§8B #7). We fix it by stamping each row with the inserting
--   txn id (`xid8`, non-wrapping) and only ever consuming rows whose txn is below
--   the snapshot xmin horizon (= no older txn still in flight), ordered by
--   (xid, id) = commit order. Gap-free by construction.
--   The prod-scale swap is a logical-replication slot (LSN cursor); this outbox is
--   the CI-testable, no-extra-Postgres-config equivalent.

CREATE TABLE IF NOT EXISTS artifact_changes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  xid         xid8 NOT NULL DEFAULT pg_current_xact_id(),  -- inserting txn (commit-order key)
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path        text NOT NULL,
  seq         int  NOT NULL,
  base_seq    int,
  sha         text,                              -- null for a delete tombstone
  status      text NOT NULL,                     -- normal | conflict
  kind        text NOT NULL,                     -- created | modified | deleted
  author      text NOT NULL,
  origin      text NOT NULL DEFAULT 'agent',     -- agent | human | node-merge (echo suppression, §8B #2)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The poll path: rows for one session, in commit order, past a (xid,id) cursor.
CREATE INDEX IF NOT EXISTS artifact_changes_session_cursor_idx
  ON artifact_changes (session_id, xid, id);

-- Emit one change-feed row per committed version. session_id/path are denormalized
-- off the artifact so the egress poller never joins. `origin` is read from a
-- txn-local GUC (`atrium.change_origin`) so the human write-back lane can tag
-- 'human' and the node-side merge lane can tag 'node-merge' (its own writes are
-- then trivially echo-suppressed) without changing any INSERT call sites.
CREATE OR REPLACE FUNCTION artifact_changes_emit() RETURNS trigger AS $$
DECLARE
  a_session uuid;
  a_path    text;
BEGIN
  SELECT session_id, path INTO a_session, a_path FROM artifacts WHERE id = NEW.artifact_id;
  INSERT INTO artifact_changes
    (artifact_id, session_id, path, seq, base_seq, sha, status, kind, author, origin)
  VALUES
    (NEW.artifact_id, a_session, a_path, NEW.seq, NEW.base_seq, NEW.blob_sha,
     NEW.status, NEW.kind, NEW.author,
     COALESCE(NULLIF(current_setting('atrium.change_origin', true), ''), 'agent'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_versions_emit_change ON artifact_versions;
CREATE TRIGGER artifact_versions_emit_change
  AFTER INSERT ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION artifact_changes_emit();

-- The per-path sync-state record — the single source of truth for "current base +
-- byte-origin per path in this container's working copy" (§8A takeaway #1). Held
-- server-side so the node component is crash-recoverable; the node mirrors it.
--   base_seq           = the version this container hydrated / last cleanly adopted
--   base_sha           = bytes of that base (null if base is a delete tombstone)
--   upper_sha          = the agent's current working-copy bytes (null = unedited)
--   applied_remote_seq = last remote seq the node wrote through `merged` (echo gate)
CREATE TABLE IF NOT EXISTS artifact_sync_state (
  session_id         uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path               text NOT NULL,
  base_seq           int  NOT NULL,
  base_sha           text,
  upper_sha          text,
  applied_remote_seq int,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, path)
);
