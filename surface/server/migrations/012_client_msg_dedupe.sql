-- Idempotent sends: the mobile offline outbox legitimately retries a send
-- whose response was lost. Dedupe message.posted by (actor, channel,
-- client_msg_id) so a landed-but-unacknowledged request can't duplicate.

CREATE UNIQUE INDEX IF NOT EXISTS events_client_msg_dedupe
  ON events (actor_id, channel_id, (payload->>'client_msg_id'))
  WHERE type = 'message.posted' AND payload->>'client_msg_id' IS NOT NULL;
