-- Gap-free, global change-feed over the session_records projection. Consumers
-- poll by the non-wrapping transaction id plus row id cursor `(xid, id)`, not by
-- id alone, so concurrent transactions cannot make a lower id visible after the
-- consumer has advanced past it.

CREATE TABLE IF NOT EXISTS session_record_changes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  xid          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_count int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_record_changes_cursor_idx
  ON session_record_changes (xid, id);

CREATE INDEX IF NOT EXISTS session_record_changes_session_cursor_idx
  ON session_record_changes (session_id, xid, id);

-- The global poller takes the matching exclusive lock non-blocking. If any
-- writer is mid-flight, it withholds the page and leaves the cursor unchanged.
CREATE OR REPLACE FUNCTION session_record_changes_writer_lock() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('session_record_changes', 0)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS session_record_changes_writer_lock ON session_record_changes;
CREATE TRIGGER session_record_changes_writer_lock
  BEFORE INSERT ON session_record_changes
  FOR EACH ROW EXECUTE FUNCTION session_record_changes_writer_lock();
