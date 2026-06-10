-- Atrium "Places" Phase 1 schema.
-- Single append-only `events` table is the source of truth for messages.
-- workspaces / channels / users / sessions are lightweight read models
-- maintained transactionally with the corresponding event insert.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- Append-only event log. Event types (Phase 1):
--   workspace.created, channel.created, message.posted, message.edited
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  channel_id uuid REFERENCES channels(id),
  thread_root_event_id bigint REFERENCES events(id),
  type text NOT NULL,
  actor_id uuid REFERENCES users(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Channel timeline reads (root messages only, paginated by id).
CREATE INDEX IF NOT EXISTS events_channel_timeline
  ON events (channel_id, id)
  WHERE type = 'message.posted' AND thread_root_event_id IS NULL;

-- All message events in a channel (used for after_id catch-up reads).
CREATE INDEX IF NOT EXISTS events_channel_all
  ON events (channel_id, id);

-- Thread reads + reply counts.
CREATE INDEX IF NOT EXISTS events_thread
  ON events (thread_root_event_id, id)
  WHERE thread_root_event_id IS NOT NULL;

-- Latest-edit lookup when folding message.edited into reads.
CREATE INDEX IF NOT EXISTS events_edit_target
  ON events ((((payload->>'target_event_id'))::bigint))
  WHERE type = 'message.edited';
