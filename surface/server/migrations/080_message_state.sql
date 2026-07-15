CREATE TABLE message_state (
  event_id bigint PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  edited_text text,
  is_deleted boolean NOT NULL DEFAULT false,
  suppressed_unfurls jsonb,
  reactions jsonb,
  reply_count int NOT NULL DEFAULT 0,
  last_reply_id bigint,
  last_modifier_id bigint NOT NULL
);

CREATE OR REPLACE FUNCTION refold_message_state(target bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- The two-key advisory-lock API takes int4 keys, so hash the bigint event id
  -- into the second key. Collisions only add harmless serialization. The first
  -- key is a fixed namespace for message-state folds (ASCII "MSGS").
  PERFORM pg_advisory_xact_lock(1297303379, hashint8(target));

  -- This statement intentionally executes after the lock. Under READ COMMITTED
  -- it receives a fresh snapshot that can see the preceding lock holder's commit.
  INSERT INTO message_state (
    event_id,
    edited_text,
    is_deleted,
    suppressed_unfurls,
    reactions,
    reply_count,
    last_reply_id,
    last_modifier_id
  )
  WITH target_event AS (
    SELECT id, thread_root_event_id
    FROM events
    WHERE id = target
  ),
  direct_modifiers AS (
    SELECT x.*
    FROM events x
    WHERE x.type IN (
      'message.edited',
      'message.deleted',
      'message.unfurls_suppressed',
      'reaction.added',
      'reaction.removed'
    )
      AND x.payload->>'target' = ('evt_' || target::text)
  ),
  replies AS (
    SELECT x.*
    FROM events x
    CROSS JOIN target_event t
    WHERE t.thread_root_event_id IS NULL
      AND x.thread_root_event_id = t.id
      AND x.type IN (
        'message.posted',
        'session.replied',
        'session.question_requested',
        'session.question_answered',
        'session.question_resolved'
      )
  ),
  reply_modifiers AS (
    SELECT x.*
    FROM events x
    JOIN replies r ON x.payload->>'target' = ('evt_' || r.id::text)
    WHERE x.type IN (
      'message.edited',
      'message.deleted',
      'message.unfurls_suppressed',
      'reaction.added',
      'reaction.removed'
    )
  ),
  visible_replies AS (
    SELECT r.*
    FROM replies r
    WHERE NOT EXISTS (
      SELECT 1
      FROM reply_modifiers d
      WHERE d.type = 'message.deleted'
        AND d.payload->>'target' = ('evt_' || r.id::text)
    )
  )
  SELECT
    t.id,
    (
      SELECT x.payload->>'text'
      FROM direct_modifiers x
      WHERE x.type = 'message.edited'
      ORDER BY x.id DESC
      LIMIT 1
    ),
    EXISTS (
      SELECT 1
      FROM direct_modifiers x
      WHERE x.type = 'message.deleted'
    ),
    (
      SELECT x.payload->'suppressed'
      FROM direct_modifiers x
      WHERE x.type = 'message.unfurls_suppressed'
      ORDER BY x.id DESC
      LIMIT 1
    ),
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
          FROM direct_modifiers x
          WHERE x.type IN ('reaction.added', 'reaction.removed')
          GROUP BY x.actor_id, x.payload->>'emoji'
        ) net_reactions
        WHERE net > 0
        GROUP BY emoji
      ) reaction_groups
    ),
    CASE
      WHEN t.thread_root_event_id IS NULL THEN (SELECT count(*)::int FROM visible_replies)
      ELSE 0
    END,
    CASE
      WHEN t.thread_root_event_id IS NULL THEN (SELECT max(id) FROM visible_replies)
      ELSE NULL
    END,
    GREATEST(
      t.id,
      COALESCE((SELECT max(id) FROM direct_modifiers), t.id),
      COALESCE((SELECT max(id) FROM replies), t.id),
      COALESCE((SELECT max(id) FROM reply_modifiers), t.id)
    )
  FROM target_event t
  ON CONFLICT (event_id) DO UPDATE SET
    edited_text = EXCLUDED.edited_text,
    is_deleted = EXCLUDED.is_deleted,
    suppressed_unfurls = EXCLUDED.suppressed_unfurls,
    reactions = EXCLUDED.reactions,
    reply_count = EXCLUDED.reply_count,
    last_reply_id = EXCLUDED.last_reply_id,
    last_modifier_id = EXCLUDED.last_modifier_id
  WHERE message_state.last_modifier_id <= EXCLUDED.last_modifier_id;
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

-- Backfill: refold every row-owning timeline event once. Modifier events need
-- no separate pass — their effects are folded when their target refolds. (The
-- per-event project_message_event() cascade would re-refold each thread root
-- once per reply: quadratic on busy threads and pointless for a backfill.)
-- The checked-in production database is small. Large self-hosted instances
-- should use scripts/rebuild-message-state.mts for an explicit chunked rebuild.
SELECT refold_message_state(id) FROM events
WHERE type IN ('message.posted', 'voice.transcribed', 'session.spawned', 'session.replied', 'session.status_changed', 'session.effort_changed', 'session.completed', 'session.archived', 'session.unarchived', 'session.seat_requested', 'session.seat_changed', 'session.question_requested', 'session.question_answered', 'session.question_resolved', 'session.provider_auth_required', 'session.github_auth_required', 'session.provider_auth_resolved')
ORDER BY id;
