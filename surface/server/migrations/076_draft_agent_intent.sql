-- A draft remembers who it was for. Without this, `!! fix the build` + Esc
-- roams to another device as an innocent chat draft with the sigil stripped —
-- one reflexive Enter and an agent command posts as chat no agent will read.
ALTER TABLE user_drafts
  ADD COLUMN IF NOT EXISTS agent_intent boolean NOT NULL DEFAULT false;
