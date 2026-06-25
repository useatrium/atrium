CREATE TABLE IF NOT EXISTS apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('channel', 'workspace')),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'disabled')),
  current_version int NOT NULL DEFAULT 0,
  entry_path text NOT NULL DEFAULT 'index.html',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CHECK ((scope = 'channel' AND channel_id IS NOT NULL) OR scope = 'workspace')
);

CREATE UNIQUE INDEX IF NOT EXISTS apps_channel_name_idx
  ON apps (workspace_id, channel_id, name)
  WHERE scope = 'channel';

CREATE UNIQUE INDEX IF NOT EXISTS apps_workspace_name_idx
  ON apps (workspace_id, name)
  WHERE scope = 'workspace';

CREATE TABLE IF NOT EXISTS app_versions (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version int NOT NULL,
  rel_path text NOT NULL,
  artifact_id uuid NOT NULL,
  artifact_seq int NOT NULL,
  blob_sha text NOT NULL REFERENCES cas_blobs(sha256),
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  entry boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version, rel_path),
  CHECK (version > 0),
  CHECK (rel_path <> '' AND rel_path NOT LIKE '/%' AND rel_path NOT LIKE '%..%')
);

CREATE INDEX IF NOT EXISTS app_versions_blob_sha_idx
  ON app_versions (blob_sha);

CREATE UNIQUE INDEX IF NOT EXISTS app_versions_one_entry_idx
  ON app_versions (app_id, version)
  WHERE entry;
