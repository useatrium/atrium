-- Pathfinder static artifact apps. This freezes a workspace-visible artifact
-- directory into numbered app versions; the first implementation launches via
-- Atrium's authenticated artifact preview route, while preserving enough rows
-- to move serving to a separate apps origin later.

CREATE TABLE IF NOT EXISTS artifact_apps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id      uuid REFERENCES channels(id) ON DELETE SET NULL,
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL,
  name            text NOT NULL,
  root_path       text NOT NULL,
  entry           text NOT NULL DEFAULT 'index.html',
  description     text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  current_version int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'published',
  UNIQUE (workspace_id, name),
  CHECK (status IN ('published', 'pending_offload', 'unpublished'))
);

CREATE TABLE IF NOT EXISTS artifact_app_versions (
  app_id        uuid NOT NULL REFERENCES artifact_apps(id) ON DELETE CASCADE,
  version       int NOT NULL,
  rel_path      text NOT NULL,
  source_path   text NOT NULL,
  artifact_id   uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_seq   int NOT NULL,
  blob_sha      text NOT NULL REFERENCES cas_blobs(sha256),
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version, rel_path),
  FOREIGN KEY (artifact_id, version_seq) REFERENCES artifact_versions (artifact_id, seq)
);

CREATE INDEX IF NOT EXISTS artifact_apps_workspace_idx
  ON artifact_apps (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS artifact_app_versions_lookup_idx
  ON artifact_app_versions (app_id, version);
