ALTER TABLE users ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
