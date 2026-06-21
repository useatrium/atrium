CREATE TABLE IF NOT EXISTS artifact_commit_groups (
  group_id     text PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  result       jsonb,            -- null until committed; then {ok, results:[...]}
  created_at   timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
CREATE INDEX IF NOT EXISTS artifact_commit_groups_session_idx
  ON artifact_commit_groups (session_id, created_at DESC);

ALTER TABLE artifact_changes ADD COLUMN IF NOT EXISTS group_id text;  -- nullable; set by commit-group
