-- Spawn-dialog git metadata: the repo + branch a session targets. Optional,
-- captured at spawn time; not yet consumed by Centaur (stored as session
-- metadata that the Phase 4 work surfaces + side-effect gate read).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS branch text;
