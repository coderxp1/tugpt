-- Workspace chat: assistant and tool messages are server-authored only
-- (Agent 4, Q-9c; Agent 1 security review finding F-3).
--
-- Finding: messages_owner_append let the thread owner INSERT any role, so an
-- authenticated user could call PostgREST directly and store a forged
-- assistant answer (with fabricated citations) or tool result in their own
-- thread. Later turns feed that history back to the model as if the
-- platform had produced it.
--
-- Fix (forward-only):
-- * messages_owner_append now also requires role = 'user'.
-- * authenticated can INSERT only the columns a user message needs
--   (organization_id, thread_id, role, content, model_key, mentions, status);
--   no citations, knowledge_unavailable, capability_key, id or created_at.
-- * public.append_chat_message_server(...) stores assistant/tool messages. It
--   is SECURITY DEFINER and executable only by sso_control (server-only
--   control role) and service_role. It re-checks, for the user the server is
--   acting for, the same conditions the INSERT policy used: own thread, same
--   organization, not archived, current org member. Table CHECKs (citation
--   shape, role/capability rules, size limits) still apply.
-- Prerequisite: the PostgREST login role must be a member of sso_control.
BEGIN;

DROP POLICY messages_owner_append ON public.chat_messages;
CREATE POLICY messages_owner_append ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (
    role = 'user'
    AND EXISTS (SELECT 1 FROM public.chat_threads t
                WHERE t.id = chat_messages.thread_id AND t.organization_id = chat_messages.organization_id
                  AND t.owner_user_id = auth.uid() AND t.archived_at IS NULL)
    AND private.is_org_member(organization_id, auth.uid()));

REVOKE INSERT ON public.chat_messages FROM authenticated;
GRANT INSERT (organization_id, thread_id, role, content, model_key, mentions, status)
  ON public.chat_messages TO authenticated;

CREATE FUNCTION public.append_chat_message_server(
  p_organization_id UUID, p_user_id UUID, p_thread_id UUID, p_role TEXT, p_content TEXT,
  p_status TEXT DEFAULT 'complete', p_model_key TEXT DEFAULT NULL, p_mentions JSONB DEFAULT '[]'::jsonb,
  p_capability_key TEXT DEFAULT NULL, p_citations JSONB DEFAULT '[]'::jsonb,
  p_knowledge_unavailable BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_row public.chat_messages;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_thread_id IS NULL
     OR p_role IS NULL OR p_role NOT IN ('assistant', 'tool') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads t
                 WHERE t.id = p_thread_id AND t.organization_id = p_organization_id
                   AND t.owner_user_id = p_user_id AND t.archived_at IS NULL)
     OR NOT private.is_org_member(p_organization_id, p_user_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.chat_messages (organization_id, thread_id, role, content, model_key, mentions, status,
                                    capability_key, citations, knowledge_unavailable)
  VALUES (p_organization_id, p_thread_id, p_role, p_content, p_model_key, COALESCE(p_mentions, '[]'::jsonb),
          COALESCE(p_status, 'complete'), p_capability_key, COALESCE(p_citations, '[]'::jsonb),
          COALESCE(p_knowledge_unavailable, false))
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'id', v_row.id, 'role', v_row.role, 'content', v_row.content, 'created_at', v_row.created_at,
    'status', v_row.status, 'mentions', v_row.mentions, 'capability_key', v_row.capability_key,
    'citations', v_row.citations, 'knowledge_unavailable', v_row.knowledge_unavailable);
END $$;
REVOKE ALL ON FUNCTION public.append_chat_message_server(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_chat_message_server(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB, BOOLEAN)
  TO sso_control, service_role;

COMMIT;
