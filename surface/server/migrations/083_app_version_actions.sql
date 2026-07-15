CREATE TABLE IF NOT EXISTS app_version_actions (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version integer NOT NULL,
  action_name text NOT NULL,
  title text,
  description text,
  confirm_policy text NOT NULL DEFAULT 'always',
  idempotency_policy text NOT NULL DEFAULT 'required',
  input_schema jsonb NOT NULL DEFAULT '{"type":"object","additionalProperties":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version, action_name),
  CONSTRAINT app_version_actions_version_check
    CHECK (version > 0),
  CONSTRAINT app_version_actions_confirm_policy_check
    CHECK (confirm_policy IN ('always', 'never')),
  CONSTRAINT app_version_actions_idempotency_policy_check
    CHECK (idempotency_policy IN ('required', 'optional')),
  CONSTRAINT app_version_actions_name_check
    CHECK (action_name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE INDEX IF NOT EXISTS app_version_actions_lookup_idx
  ON app_version_actions (app_id, version);
