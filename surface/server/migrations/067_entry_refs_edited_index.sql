CREATE INDEX IF NOT EXISTS events_message_edited_entry_refs_gin
  ON events USING gin ((payload->'entry_refs') jsonb_path_ops)
  WHERE type = 'message.edited';
