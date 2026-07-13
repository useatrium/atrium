ALTER TABLE session_projection_state
  ADD COLUMN generation bigint NOT NULL DEFAULT 1;

-- A full projection starts by deleting the session's existing records. Using
-- a transition table keeps the generation bump in the projector's transaction
-- without incrementing once per deleted record.
CREATE FUNCTION bump_session_projection_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE session_projection_state state
     SET generation = state.generation + 1,
         updated_at = now()
    FROM (SELECT DISTINCT session_id FROM deleted_session_records) deleted
   WHERE state.session_id = deleted.session_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER session_records_full_reprojection_generation
AFTER DELETE ON session_records
REFERENCING OLD TABLE AS deleted_session_records
FOR EACH STATEMENT
EXECUTE FUNCTION bump_session_projection_generation();
