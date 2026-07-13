-- Suggestions carry the proposer's attachments instead of silently dropping
-- them. Two shapes, mirroring the steer body: the validated agent-turn inputs
-- (re-resolved when the driver sends) and the display metadata for chat rows.
ALTER TABLE session_suggestions ADD COLUMN attachment_inputs jsonb;
ALTER TABLE session_suggestions ADD COLUMN attachment_meta jsonb;
