-- B1 prod-hardening: claim-then-release offload + terminal evicted mark.
--
-- The offload worker used to hold one transaction (with FOR UPDATE row locks)
-- open across the whole batch's Centaur fetch + S3 upload. `claimed_at` turns
-- that into a lease: the worker claims a batch in a short tx (stamping
-- claimed_at), releases the locks, does the slow network hops outside any tx,
-- then stamps the result. A row whose claim is older than the lease window is
-- reclaimable again — that covers a worker that crashed mid-upload.
--
-- `evicted_at` is a terminal mark: a ref Centaur 404s is gone for good, so the
-- row drops out of the offload queue instead of being re-claimed every lease
-- (under the old single-tx design an evicted ref had no terminal state and
-- stayed selectable forever — cheap, but it churned the lease every tick).

ALTER TABLE session_artifacts ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE session_artifacts ADD COLUMN IF NOT EXISTS evicted_at timestamptz;

-- Rebuild the offload queue index to also exclude terminally-evicted rows. The
-- claim lease lives in the worker's WHERE clause (not the index predicate) so
-- the index stays a small set of not-yet-terminal rows.
DROP INDEX IF EXISTS session_artifacts_offload_queue_idx;
CREATE INDEX IF NOT EXISTS session_artifacts_offload_queue_idx
  ON session_artifacts (captured_at)
  WHERE offloaded_at IS NULL AND evicted_at IS NULL AND centaur_ref IS NOT NULL;
