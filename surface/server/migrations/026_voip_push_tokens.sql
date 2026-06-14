-- VoIP push tokens for CallKit / Android Core-Telecom incoming-call wake (Phase 3).
-- A device registers two distinct tokens: its Expo notification token
-- (kind='expo', for message pushes) and its VoIP token — APNs PushKit on iOS or
-- an FCM data-message token on Android (kind='voip', for call ringing). Distinct
-- tokens => distinct rows; `kind` tells the server which transport to use.
ALTER TABLE push_tokens
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'expo';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_tokens_kind_check') THEN
    ALTER TABLE push_tokens
      ADD CONSTRAINT push_tokens_kind_check CHECK (kind IN ('expo', 'voip'));
  END IF;
END $$;

-- Callee lookup at ring time: VoIP tokens by user.
CREATE INDEX IF NOT EXISTS push_tokens_voip_idx
  ON push_tokens (user_id) WHERE kind = 'voip';
