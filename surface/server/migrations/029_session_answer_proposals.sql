-- Spectator-proposed HITL answers (Phase 2 collaboration). When the agent asks
-- a question, a watcher who is not the driver proposes an answer; the driver
-- one-click submits it (driver-attributed) or dismisses it. Resolved rows
-- persist (retro value); status records the disposition. answers is the same
-- shape the answer route takes: { [questionId]: { answers: text[] } }.
CREATE TABLE session_answer_proposals (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id  text        NOT NULL,
  author_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers      jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'submitted', 'dismissed')),
  -- The driver who resolved it (SET NULL on delete so the disposition record
  -- outlives the resolver); an optional "why" on dismiss.
  resolved_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX session_answer_proposals_session
  ON session_answer_proposals (session_id, question_id, created_at);
