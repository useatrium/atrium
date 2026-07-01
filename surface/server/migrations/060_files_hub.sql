CREATE TABLE IF NOT EXISTS artifact_labels (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  label text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, label)
);

CREATE TABLE IF NOT EXISTS artifact_stars (
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, user_id)
);

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;

ALTER TABLE artifact_versions
  ADD COLUMN IF NOT EXISTS source_message_id uuid;

CREATE INDEX IF NOT EXISTS artifacts_workspace_id_idx
  ON artifacts (workspace_id);

CREATE INDEX IF NOT EXISTS artifacts_lower_path_idx
  ON artifacts (lower(path));

CREATE INDEX IF NOT EXISTS artifact_labels_label_idx
  ON artifact_labels (label, artifact_id);

CREATE INDEX IF NOT EXISTS artifact_stars_user_idx
  ON artifact_stars (user_id, artifact_id);

CREATE INDEX IF NOT EXISTS artifact_versions_source_message_id_idx
  ON artifact_versions (source_message_id)
  WHERE source_message_id IS NOT NULL;
