CREATE TABLE IF NOT EXISTS user_drafts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_key text NOT NULL,
  text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, draft_key)
);
