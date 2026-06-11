ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS client_spawn_id text;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_client_spawn_id_unique
  ON sessions (spawned_by, client_spawn_id)
  WHERE client_spawn_id IS NOT NULL;
