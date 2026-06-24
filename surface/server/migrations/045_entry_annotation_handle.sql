CREATE INDEX IF NOT EXISTS events_target ON events ((payload->>'target'))
  WHERE payload->>'target' IS NOT NULL;

DROP INDEX IF EXISTS events_edit_target;
