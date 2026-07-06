CREATE INDEX IF NOT EXISTS events_channel_broadcast ON events (channel_id, id)
  WHERE type = 'message.posted' AND thread_root_event_id IS NOT NULL AND (payload->>'broadcast')::boolean;
