-- The durable "who answered what" trace for the session's most recent agent
-- question, written in the same transaction that clears pending_question.
--
-- The event log already records it (session.question_answered carries the
-- answering user as its actor), but replaying the log is not something a cold
-- session read does — so a fresh pane or a week-old thread would show no
-- answerer at all. This column rides along with the session row on every read,
-- PK-indexed, and is NULLed whenever a new question supersedes it.
ALTER TABLE sessions ADD COLUMN answered_question jsonb;
