-- Warm-cache manifest: maps a workspace's dependency set (lockfile hash + kind)
-- to the content-addressed blobs that make up its installed cache (node_modules,
-- cargo registry, pnpm store, ...). This is MACHINE state, deliberately kept out
-- of the artifact ledger so it never surfaces in the Files / changes UI (same
-- rule as harness-state bundles). Blob bytes live in the shared cas_blobs CAS;
-- this table is the per-(workspace, lockfile, kind) index that hydration reads.
CREATE TABLE warmcache_blobs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lockfile_hash text NOT NULL,
  kind          text NOT NULL,
  path          text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, lockfile_hash, kind, path)
);

-- Hydration lookup: every entry for one dependency set.
CREATE INDEX warmcache_blobs_lookup_idx
  ON warmcache_blobs (workspace_id, lockfile_hash, kind);

-- GC root lookup: is this blob still referenced by any warm cache?
CREATE INDEX warmcache_blobs_sha_idx ON warmcache_blobs (sha256);
