-- Track the last successful warm-cache hydration for TTL and size-cap eviction.
ALTER TABLE warmcache_blobs
  ADD COLUMN last_hydrated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX warmcache_blobs_evict_idx
  ON warmcache_blobs (workspace_id, last_hydrated_at);
