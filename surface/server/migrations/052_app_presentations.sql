CREATE TABLE IF NOT EXISTS app_presentations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  app_slug text NOT NULL,
  version int NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  title text,
  description text,
  renderer text NOT NULL DEFAULT 'html-app',
  entry_path text NOT NULL,
  preview_url text,
  preview_size_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_policy jsonb NOT NULL DEFAULT '{"mode":"isolated"}'::jsonb,
  manifest_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  manifest_artifact_seq int,
  manifest_blob_sha text REFERENCES cas_blobs(sha256),
  entry_artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  entry_artifact_seq int NOT NULL,
  entry_blob_sha text NOT NULL REFERENCES cas_blobs(sha256),
  source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, app_slug, version),
  CHECK (version > 0),
  CHECK (app_slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CHECK (entry_path <> '' AND entry_path NOT LIKE '/%' AND entry_path NOT LIKE '%..%')
);

CREATE INDEX IF NOT EXISTS app_presentations_session_latest_idx
  ON app_presentations (session_id, app_slug, version DESC);

CREATE INDEX IF NOT EXISTS app_presentations_workspace_idx
  ON app_presentations (workspace_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS app_presentations_snapshot_idx
  ON app_presentations (
    session_id,
    app_slug,
    entry_path,
    entry_blob_sha,
    COALESCE(manifest_blob_sha, '')
  );
