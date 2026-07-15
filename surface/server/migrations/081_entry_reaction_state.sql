CREATE TABLE entry_reaction_state (
  target text PRIMARY KEY,
  reactions jsonb,
  last_reaction_id bigint NOT NULL
);

COMMENT ON TABLE entry_reaction_state IS
  'Reaction projection keyed by durable entry handles; orphaned handles are accepted because entries have no GC.';

CREATE OR REPLACE FUNCTION refold_entry_reactions(target_handle text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Use the two-key advisory-lock API so this projection cannot collide with
  -- setEntryReactionTx's single-key hashtext(handle) serialization lock. The
  -- first key is a fixed namespace for entry-reaction folds (ASCII "ENTR").
  PERFORM pg_advisory_xact_lock(1162760274, hashtext(target_handle));

  -- This statement intentionally executes after the lock. Under READ COMMITTED
  -- it receives a fresh snapshot that can see the preceding lock holder's commit.
  INSERT INTO entry_reaction_state (target, reactions, last_reaction_id)
  WITH modifiers AS (
    SELECT x.*
    FROM events x
    WHERE x.type IN ('reaction.added', 'reaction.removed')
      AND x.payload->>'target' = target_handle
  )
  SELECT
    target_handle,
    (
      SELECT jsonb_agg(
        jsonb_build_object('emoji', emoji, 'userIds', user_ids)
        ORDER BY emoji_first_id
      )
      FROM (
        SELECT
          emoji,
          jsonb_agg(actor_id ORDER BY first_id) AS user_ids,
          MIN(first_id) AS emoji_first_id
        FROM (
          SELECT
            x.actor_id,
            x.payload->>'emoji' AS emoji,
            SUM(CASE WHEN x.type = 'reaction.added' THEN 1 ELSE -1 END) AS net,
            MIN(x.id) AS first_id
          FROM modifiers x
          GROUP BY x.actor_id, x.payload->>'emoji'
        ) net_reactions
        WHERE net > 0
        GROUP BY emoji
      ) reaction_groups
    ),
    COALESCE((SELECT max(id) FROM modifiers), 0)
  ON CONFLICT (target) DO UPDATE SET
    reactions = EXCLUDED.reactions,
    last_reaction_id = EXCLUDED.last_reaction_id
  WHERE entry_reaction_state.last_reaction_id <= EXCLUDED.last_reaction_id;
END;
$$;

CREATE OR REPLACE FUNCTION project_message_event(ev_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  ev_type text;
  ev_thread_root_id bigint;
  target_handle text;
  target_id bigint;
  target_root_id bigint;
BEGIN
  SELECT type, thread_root_event_id
  INTO ev_type, ev_thread_root_id
  FROM events
  WHERE id = ev_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF ev_type IN (
    'message.edited',
    'message.unfurls_suppressed',
    'message.deleted',
    'reaction.added',
    'reaction.removed'
  ) THEN
    SELECT payload->>'target'
    INTO target_handle
    FROM events
    WHERE id = ev_id;

    IF (ev_type = 'reaction.added' OR ev_type = 'reaction.removed')
       AND target_handle ~ '^(rec_|art_)' THEN
      PERFORM refold_entry_reactions(target_handle);
      RETURN;
    END IF;

    IF target_handle IS NULL OR target_handle !~ '^evt_[0-9]{1,19}$' THEN
      RETURN;
    END IF;

    BEGIN
      target_id := substring(target_handle FROM 5)::bigint;
    EXCEPTION WHEN numeric_value_out_of_range THEN
      RETURN;
    END;

    SELECT thread_root_event_id
    INTO target_root_id
    FROM events
    WHERE id = target_id;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    IF target_root_id IS NULL OR target_root_id = target_id THEN
      PERFORM refold_message_state(target_id);
    ELSIF target_root_id < target_id THEN
      PERFORM refold_message_state(target_root_id);
      PERFORM refold_message_state(target_id);
    ELSE
      PERFORM refold_message_state(target_id);
      PERFORM refold_message_state(target_root_id);
    END IF;

    RETURN;
  END IF;

  IF ev_type IN (
    'message.posted',
    'voice.transcribed',
    'session.spawned',
    'session.replied',
    'session.status_changed',
    'session.effort_changed',
    'session.completed',
    'session.archived',
    'session.unarchived',
    'session.seat_requested',
    'session.seat_changed',
    'session.question_requested',
    'session.question_answered',
    'session.question_resolved',
    'session.provider_auth_required',
    'session.github_auth_required',
    'session.provider_auth_resolved'
  ) THEN
    IF ev_thread_root_id IS NULL OR ev_thread_root_id = ev_id THEN
      PERFORM refold_message_state(ev_id);
    ELSIF ev_thread_root_id < ev_id THEN
      PERFORM refold_message_state(ev_thread_root_id);
      PERFORM refold_message_state(ev_id);
    ELSE
      PERFORM refold_message_state(ev_id);
      PERFORM refold_message_state(ev_thread_root_id);
    END IF;
  END IF;
END;
$$;

SELECT refold_entry_reactions(t)
FROM (
  SELECT DISTINCT payload->>'target' AS t
  FROM events
  WHERE type IN ('reaction.added', 'reaction.removed')
    AND payload->>'target' !~ '^evt_'
) s;
