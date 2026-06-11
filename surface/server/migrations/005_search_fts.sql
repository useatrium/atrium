-- Full-text search over message text (posted + edited revisions).
-- The partial GIN index keeps it cheap on the append-only events table.

CREATE INDEX IF NOT EXISTS events_message_fts
  ON events
  USING gin (to_tsvector('english', coalesce(payload->>'text', '')))
  WHERE type IN ('message.posted', 'message.edited');
