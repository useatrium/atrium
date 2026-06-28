CREATE TABLE IF NOT EXISTS client_error_reports (
  id             bigserial PRIMARY KEY,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  kind           text NOT NULL,
  error_name     text,
  message_hash   text,
  stack_hash     text,
  message_length int,
  stack_length   int,
  url_path       text,
  component      text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_error_reports_created
  ON client_error_reports (created_at DESC);

CREATE INDEX IF NOT EXISTS client_error_reports_kind_created
  ON client_error_reports (kind, created_at DESC);
