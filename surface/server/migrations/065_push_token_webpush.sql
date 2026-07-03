ALTER TABLE push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_kind_check;

ALTER TABLE push_tokens
  ADD CONSTRAINT push_tokens_kind_check CHECK (kind IN ('expo', 'voip', 'webpush'));

ALTER TABLE push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_platform_check;

ALTER TABLE push_tokens
  ADD CONSTRAINT push_tokens_platform_check CHECK (platform IN ('ios', 'android', 'web'));

ALTER TABLE push_tokens
  ADD COLUMN IF NOT EXISTS subscription jsonb;
