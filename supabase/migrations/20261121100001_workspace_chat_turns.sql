-- 20261121100001_workspace_chat_turns.sql — Q-12: idempotent chat turns.
--
-- A "turn" is one user message and the assistant (and tool) messages written
-- for it. The browser chooses the turn id (a UUID) before it sends, so after
-- an ambiguous failure (network error, 5xx, dropped stream) it can ask
-- whether the turn exists, and retry it, without sending the prompt twice.
--
-- Additive only (expand step), so the previous app keeps working:
-- - chat_messages.turn_id: nullable; existing rows and turn-less sends keep NULL.
-- - At most one user message per (thread, turn): a repeated send of the same
--   turn cannot create a second user message, even under a race.
-- - authenticated may read turn_id and write it on its own user messages
--   (the INSERT policy from 20261120200003 still requires role = 'user').
-- - append_chat_turn_message_server: a new sibling of
--   append_chat_message_server (which is unchanged) that also stamps the turn
--   id, and only for a turn whose user message already exists in that thread.
--   A separate name, not an overload, so PostgREST never sees two candidates.
BEGIN;

ALTER TABLE public.chat_messages ADD COLUMN turn_id UUID NULL;

CREATE UNIQUE INDEX chat_messages_user_turn_unique
  ON public.chat_messages (thread_id, turn_id)
  WHERE role = 'user' AND turn_id IS NOT NULL;

CREATE INDEX chat_messages_turn_lookup
  ON public.chat_messages (thread_id, turn_id, created_at)
  WHERE turn_id IS NOT NULL;

GRANT SELECT (turn_id) ON public.chat_messages TO authenticated;
GRANT INSERT (turn_id) ON public.chat_messages TO authenticated;

CREATE FUNCTION public.append_chat_turn_message_server(
  p_organization_id UUID, p_user_id UUID, p_thread_id UUID, p_turn_id UUID, p_role TEXT, p_content TEXT,
  p_status TEXT DEFAULT 'complete', p_model_key TEXT DEFAULT NULL, p_mentions JSONB DEFAULT '[]'::jsonb,
  p_capability_key TEXT DEFAULT NULL, p_citations JSONB DEFAULT '[]'::jsonb,
  p_knowledge_unavailable BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_row public.chat_messages;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_thread_id IS NULL OR p_turn_id IS NULL
     OR p_role IS NULL OR p_role NOT IN ('assistant', 'tool') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads t
                 WHERE t.id = p_thread_id AND t.organization_id = p_organization_id
                   AND t.owner_user_id = p_user_id AND t.archived_at IS NULL)
     OR NOT private.is_org_member(p_organization_id, p_user_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- The turn must have been opened by its user message in this very thread.
  IF NOT EXISTS (SELECT 1 FROM public.chat_messages m
                 WHERE m.thread_id = p_thread_id AND m.organization_id = p_organization_id
                   AND m.turn_id = p_turn_id AND m.role = 'user') THEN
    RAISE EXCEPTION 'TURN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.chat_messages (organization_id, thread_id, role, content, model_key, mentions, status,
                                    capability_key, citations, knowledge_unavailable, turn_id)
  VALUES (p_organization_id, p_thread_id, p_role, p_content, p_model_key, COALESCE(p_mentions, '[]'::jsonb),
          COALESCE(p_status, 'complete'), p_capability_key, COALESCE(p_citations, '[]'::jsonb),
          COALESCE(p_knowledge_unavailable, false), p_turn_id)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'id', v_row.id, 'role', v_row.role, 'content', v_row.content, 'created_at', v_row.created_at,
    'status', v_row.status, 'mentions', v_row.mentions, 'capability_key', v_row.capability_key,
    'citations', v_row.citations, 'knowledge_unavailable', v_row.knowledge_unavailable, 'turn_id', v_row.turn_id);
END $$;
REVOKE ALL ON FUNCTION public.append_chat_turn_message_server(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_chat_turn_message_server(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB, BOOLEAN)
  TO sso_control, service_role;

COMMIT;
