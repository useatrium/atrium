-- Spectator-authored suggested steers (Phase 2 collaboration). A watcher who is
-- not the driver proposes a message; the driver sends / edits-then-sends /
-- dismisses it. Dismissed + sent rows PERSIST (retro value): status records the
-- disposition rather than deleting the row.
CREATE TABLE session_suggestions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'dismissed')),
  -- The driver who resolved it; the actually-sent text when edited-then-sent;
  -- an optional "why" on dismiss (never required). resolved_by is SET NULL on
  -- user delete so the disposition record (retro value) outlives the resolver.
  resolved_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  sent_text    text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX session_suggestions_session
  ON session_suggestions (session_id, created_at);
