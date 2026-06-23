-- Lane C: re-scope the gap-free change-feed writer lock from per-SESSION to
-- per-WORKSPACE, matching the workspace-scoped identity (migration 042).
--
-- Migration 035 keyed the shared advisory writer lock on session_id, which was
-- correct when an artifact (and thus its change-feed) belonged to one session.
-- Now artifacts are workspace-shared: two SESSIONS can commit interleaved rows
-- for the SAME workspace feed, so the gap-free guarantee (§8B #7) must stall on
-- in-flight writers of the same WORKSPACE, not the same session. The consumer
-- (ArtifactLedger.changesSince) now takes the matching per-workspace EXCLUSIVE
-- try-lock. artifact_changes.workspace_id is denormalized by the emit trigger
-- (042), so it is set on every emit-path insert before this BEFORE-INSERT trigger
-- fires; direct inserters (node-merge lane) must likewise set workspace_id.

CREATE OR REPLACE FUNCTION artifact_changes_writer_lock() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('artifact_changes:' || NEW.workspace_id::text, 0)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
