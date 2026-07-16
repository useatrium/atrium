ALTER TABLE user_connections
  ADD COLUMN IF NOT EXISTS account_id text;

ALTER TABLE user_connection_identities
  ADD COLUMN IF NOT EXISTS account_id text;
