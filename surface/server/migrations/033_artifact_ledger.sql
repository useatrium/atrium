-- CAS-ledger v1 foundation: the durable, versioned artifact substrate that turns
-- the capture-only `session_artifacts` log into a content-addressed version chain
-- with movable pointers. See docs/archive/notes/cas-ledger-build-plan.md.
--
-- Four tables:
--   cas_blobs          global content-addressed bytes (sha256 -> S3); dedup across
--                      everything. s3_key is NULL until the offload worker uploads
--                      (pending = serve proxies from Centaur), so a version row can
--                      reference a blob whose bytes aren't durable yet.
--   artifacts          logical identity = (session_id, path). channel_id is
--                      denormalized off the session for access-gating + future
--                      channel-shared promotion.
--   artifact_versions  the chain: seq (monotonic per artifact), blob_sha, base_seq
--                      (parent), author, kind, and the jj-style conflict columns
--                      (status/conflict) which stay inert until the write-back lane.
--   artifact_pointers  movable refs; v1 only writes 'latest'.

CREATE TABLE IF NOT EXISTS cas_blobs (
  sha256     text PRIMARY KEY,
  s3_key     text,
  size_bytes bigint      NOT NULL,
  mime       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  path        text NOT NULL,
  merge_class text NOT NULL DEFAULT 'immutable-data',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, path),
  CHECK (merge_class IN ('immutable-data', 'mergeable-doc', 'derived-output'))
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  seq         int  NOT NULL,
  blob_sha    text REFERENCES cas_blobs(sha256),  -- NULL only for a delete tombstone
  base_seq    int,
  author      text NOT NULL,                       -- 'agent:<session>' | 'human:<uid>'
  kind        text NOT NULL,                       -- created | modified | deleted
  status      text NOT NULL DEFAULT 'normal',      -- normal | conflict (write-back lane)
  conflict    jsonb,                               -- both-sides payload (write-back lane)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, seq),
  CHECK (kind IN ('created', 'modified', 'deleted')),
  CHECK (status IN ('normal', 'conflict')),
  CHECK (kind = 'deleted' OR blob_sha IS NOT NULL),
  CHECK (base_seq IS NULL OR base_seq < seq)
);

-- Lookup the chain for an artifact newest-first (latest resolution, history).
CREATE INDEX IF NOT EXISTS artifact_versions_artifact_seq_desc_idx
  ON artifact_versions (artifact_id, seq DESC);

-- "What changed in this session since watermark W" feed (C1 inbound-sync source).
CREATE INDEX IF NOT EXISTS artifact_versions_created_at_idx
  ON artifact_versions (created_at);

CREATE TABLE IF NOT EXISTS artifact_pointers (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name        text NOT NULL,                       -- v1: only 'latest'
  seq         int  NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, name),
  FOREIGN KEY (artifact_id, seq) REFERENCES artifact_versions (artifact_id, seq)
);
