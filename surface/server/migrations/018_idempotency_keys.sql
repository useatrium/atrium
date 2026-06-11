CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    uuid NOT NULL,
  op_id      uuid NOT NULL,
  op_type    text NOT NULL,
  body_hash  text NOT NULL,
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, op_id)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_at
  ON idempotency_keys (created_at);
