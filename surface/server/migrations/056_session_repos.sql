-- Full checkout spec for sessions. `repo`/`branch` remain the primary display
-- fields; this column preserves multi-repo and subdir/ref choices for Centaur.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_repos jsonb;
