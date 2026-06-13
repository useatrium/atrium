-- Voice messages: async speech-to-text job + result, one row per audio file.
-- Doubles as a durable job queue — the in-process STT worker claims pending
-- rows with FOR UPDATE SKIP LOCKED and a boot-time sweep re-enqueues stragglers.
-- The audio itself is an ordinary `files` row (attachment); duration/waveform
-- live on the message.posted payload's `voice` block.
CREATE TABLE IF NOT EXISTS transcripts (
  file_id      uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  -- the message.posted event whose payload.voice this transcript patches
  event_id     bigint REFERENCES events(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id   uuid REFERENCES channels(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  text         text,
  lang         text,
  segments     jsonb,
  model        text,
  error        text,
  attempts     int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Queue scan: oldest unfinished job first.
CREATE INDEX IF NOT EXISTS transcripts_queue
  ON transcripts (created_at)
  WHERE status IN ('pending', 'processing');
