ALTER TABLE mentions
  ADD COLUMN kind text NOT NULL DEFAULT 'direct'
  CHECK (kind IN ('direct', 'channel', 'here'));
