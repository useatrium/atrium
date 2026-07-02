-- The session's current reasoning effort. Seeded at spawn from the agent
-- profile's manifest (codex model_reasoning_effort / claude effortLevel) and
-- updated when a steer carries a per-turn effort override (codex only — the
-- claude harness has no per-turn effort channel). Null = harness default.
ALTER TABLE sessions ADD COLUMN model_effort text;
