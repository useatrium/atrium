-- Addressable entries P0: give every transcript record a durable, replay-stable
-- identity (`entry_uid`) that survives a full re-projection (DELETE + reproject),
-- unlike the positional `seq`. Derived from immutable frame provenance by the
-- projection (see session-records.ts), so a rebuild reproduces it identically.
--
-- Nullable for now: the column is populated going forward by the projection and
-- backfilled by a one-shot rebuild on dev/CI data (nothing is live). Tighten to
-- NOT NULL in a later migration once the projection always sets it.
ALTER TABLE session_records ADD COLUMN IF NOT EXISTS entry_uid text;

-- Resolve `rec_<entry_uid>` -> the current (session_id, seq) row. Unique per
-- session so a handle maps to exactly one entry; the bare index serves the
-- global resolve lookup.
CREATE UNIQUE INDEX IF NOT EXISTS session_records_entry_uid_uniq
  ON session_records (session_id, entry_uid)
  WHERE entry_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS session_records_entry_uid_idx
  ON session_records (entry_uid)
  WHERE entry_uid IS NOT NULL;
