-- Why a terminal session failed, kept on the session row so a cold load can
-- explain it. The reason already reaches the session pane through
-- `session_records`, but a channel's timeline query excludes thread events, so
-- the card in the channel had only `status = failed` to render and showed a
-- bare "✕ Failed" with no cause.
--
-- Mirrors the terminal `execution_state` frame: `failure_class` is api-rs's
-- stable low-cardinality bucket, `failure_reason` the human string.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS failure_reason text;
