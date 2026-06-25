CREATE TABLE IF NOT EXISTS agent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('codex', 'claude-code')),
  name text NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_profiles_user_provider
  ON agent_profiles (user_id, provider, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('codex', 'claude-code')),
  adapter_version text NOT NULL,
  manifest_json jsonb NOT NULL,
  runtime_overlay_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_profile_versions_profile_created
  ON agent_profile_versions (profile_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS agent_profile_versions_profile_hash
  ON agent_profile_versions (profile_id, content_hash);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_profiles_current_version_fk'
  ) THEN
    ALTER TABLE agent_profiles
      ADD CONSTRAINT agent_profiles_current_version_fk
      FOREIGN KEY (current_version_id) REFERENCES agent_profile_versions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS agent_profile_version_id uuid REFERENCES agent_profile_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS session_profile_snapshots (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('codex', 'claude-code')),
  profile_version_id uuid REFERENCES agent_profile_versions(id) ON DELETE SET NULL,
  adapter_version text NOT NULL,
  baseline_hash text NOT NULL,
  baseline_manifest_json jsonb NOT NULL,
  runtime_overlay_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, provider)
);

CREATE TABLE IF NOT EXISTS session_profile_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('codex', 'claude-code')),
  base_profile_version_id uuid REFERENCES agent_profile_versions(id) ON DELETE SET NULL,
  adapter_version text NOT NULL,
  proposal_json jsonb NOT NULL,
  risk_summary_json jsonb NOT NULL,
  content_hash text NOT NULL,
  source text NOT NULL DEFAULT 'session' CHECK (source IN ('session', 'local_import')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'discarded', 'applied_to_lineage', 'saved_profile')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_profile_change_proposals_user_created
  ON session_profile_change_proposals (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS session_profile_change_proposals_session
  ON session_profile_change_proposals (session_id, provider, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS session_profile_change_proposals_pending_session_provider
  ON session_profile_change_proposals (session_id, provider)
  WHERE status = 'pending' AND session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_state_bundles (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  harness text NOT NULL CHECK (harness IN ('claude', 'codex')),
  adapter_version text NOT NULL,
  manifest_json jsonb NOT NULL,
  s3_key text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, harness)
);
