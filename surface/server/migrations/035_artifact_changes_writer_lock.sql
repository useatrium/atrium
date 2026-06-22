-- Per-session, writer-aware horizon for the gap-free change-feed.
--
-- Migration 034 gated the consumer on pg_snapshot_xmin(pg_current_snapshot()) --
-- the CLUSTER-WIDE oldest in-flight xid. That horizon is pinned by ANY
-- transaction anywhere in the Postgres instance, including unrelated work in
-- other databases (concurrent CI test shards; a busy prod cluster), so the feed
-- withholds freshly-committed rows until the whole cluster quiesces and
-- read-after-write returns []. The gap-free guarantee (§8B #7), however, only
-- needs to stall on in-flight writers OF THE SAME SESSION'S feed: a gap can
-- appear only when two transactions insert artifact_changes rows for one session
-- with interleaved (xid, id) commit order.
--
-- So scope the horizon to the session. Every artifact_changes writer takes a
-- per-session SHARED, transaction-scoped advisory lock for the life of its txn.
-- Writers never block each other (shared ∥ shared); unrelated transactions take
-- no lock at all. The consumer takes the matching per-session EXCLUSIVE lock with
-- pg_try_advisory_xact_lock (non-blocking): if a same-session writer is mid-flight
-- the try fails and the feed withholds this page (cursor unchanged, nothing
-- skipped); otherwise it reads under the lock, so its snapshot sees every
-- committed row in commit order and no new writer can interleave for the duration
-- of the read. Gap-free, and immune to unrelated cluster activity.
-- The consumer half is ArtifactLedger.changesSince (artifact-ledger.ts).
--
-- The lock fires on artifact_changes itself (not the artifact_versions emit
-- trigger) so it covers BOTH write paths: the emit trigger's insert and any
-- direct insert (e.g. the node-merge lane).

CREATE OR REPLACE FUNCTION artifact_changes_writer_lock() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('artifact_changes:' || NEW.session_id::text, 0)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_changes_writer_lock ON artifact_changes;
CREATE TRIGGER artifact_changes_writer_lock
  BEFORE INSERT ON artifact_changes
  FOR EACH ROW EXECUTE FUNCTION artifact_changes_writer_lock();
