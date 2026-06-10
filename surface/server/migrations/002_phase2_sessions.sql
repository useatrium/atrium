ALTER TABLE IF EXISTS sessions RENAME TO auth_sessions;
ALTER INDEX IF EXISTS sessions_pkey RENAME TO auth_sessions_pkey;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_root_event_id bigint REFERENCES events(id),
  centaur_thread_key text UNIQUE NOT NULL,
  harness text NOT NULL DEFAULT 'claude-code',
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('spawning', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  spawned_by uuid NOT NULL REFERENCES users(id),
  driver_id uuid REFERENCES users(id),
  current_execution_id text,
  assignment_generation int,
  last_event_id bigint NOT NULL DEFAULT 0,
  result_text text,
  cost_usd numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_workspace_channel
  ON sessions (workspace_id, channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sessions_active
  ON sessions (status, created_at)
  WHERE status IN ('spawning', 'queued', 'running');

CREATE INDEX IF NOT EXISTS events_session_roots
  ON events (channel_id, id)
  WHERE type = 'session.spawned' AND thread_root_event_id IS NULL;

CREATE INDEX IF NOT EXISTS events_thread_sessions
  ON events (thread_root_event_id, id)
  WHERE type IN ('session.spawned', 'session.status_changed', 'session.completed');
