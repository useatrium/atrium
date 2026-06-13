-- Voice calls (Phase 1). A call maps to a LiveKit room ('call:'||id); lifecycle
-- is signaled over the WS hub (ephemeral frames), media rides LiveKit separately.
-- Access is gated by channel membership at token-mint time (canAccessChannel).
CREATE TABLE IF NOT EXISTS calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  initiator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room         text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'ringing'
                 CHECK (status IN ('ringing', 'active', 'ended')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

-- The UI cares about a channel's live call; index the non-ended ones.
CREATE INDEX IF NOT EXISTS calls_channel_live
  ON calls (channel_id) WHERE status <> 'ended';

CREATE TABLE IF NOT EXISTS call_participants (
  call_id   uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz,
  PRIMARY KEY (call_id, user_id)
);
