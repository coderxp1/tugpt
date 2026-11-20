-- Workspace chat: stored citation snippets are confidential at the database
-- level after document access is revoked (Agent 4, Q-9c; Agent 1 security
-- review finding F-2).
--
-- Finding: chat_messages.citations keeps a snapshot (title + snippet) of each
-- cited document. The API re-checked document access on read, but the thread
-- owner could SELECT the raw column through PostgREST and keep reading
-- snippets of a collection that was made private or removed.
--
-- Fix (forward-only):
-- * authenticated loses column SELECT on chat_messages.citations; every other
--   column stays readable under the unchanged messages_owner_read policy.
-- * public.chat_message_citations(org, thread, message_ids[]) returns the
--   citations of the caller's own messages, filtered element by element at
--   read time: an entry is kept only if its document still exists in the
--   same organization, collection and file, and the CALLER can read that
--   collection now (private.can_read_collection, the documents_read rule).
--   Order and the original n are preserved, so [n] markers stay correct.
--   Access restored -> the entry is returned again (the snapshot is kept).
-- * INSERT column grants on citations/knowledge_unavailable are removed from
--   authenticated as well: only server-authored assistant messages carry
--   them (see 20261120200003).
-- Limitation: the assistant's answer text (content) may quote the source; it
-- is not rewritten. Retention/deletion of the snapshot itself is unchanged.
BEGIN;

REVOKE SELECT ON public.chat_messages FROM authenticated;
GRANT SELECT (id, thread_id, organization_id, role, content, model_key, mentions, capability_key, status,
              created_at, knowledge_unavailable)
  ON public.chat_messages TO authenticated;

CREATE FUNCTION public.chat_message_citations(p_organization_id UUID, p_thread_id UUID, p_message_ids UUID[])
RETURNS TABLE (message_id UUID, citations JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL OR p_thread_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_message_ids IS NULL OR cardinality(p_message_ids) > 400 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  -- Same rule as messages_owner_read: own thread, current org member.
  -- Anything else yields no rows (no existence oracle).
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads t
                 WHERE t.id = p_thread_id AND t.organization_id = p_organization_id AND t.owner_user_id = v_uid)
     OR NOT private.is_org_member(p_organization_id, v_uid) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT m.id,
           COALESCE((SELECT jsonb_agg(e.c ORDER BY e.i)
                     FROM jsonb_array_elements(m.citations) WITH ORDINALITY AS e(c, i)
                     WHERE EXISTS (SELECT 1 FROM public.knowledge_documents d
                                   WHERE d.id = (e.c->>'documentId')::uuid
                                     AND d.organization_id = p_organization_id
                                     AND d.collection_id = (e.c->>'collectionId')::uuid
                                     AND d.file_id = (e.c->>'fileId')::uuid
                                     AND private.can_read_collection(d.collection_id, v_uid))),
                    '[]'::jsonb)
    FROM public.chat_messages m
    WHERE m.thread_id = p_thread_id AND m.organization_id = p_organization_id
      AND m.id = ANY (p_message_ids) AND m.citations <> '[]'::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.chat_message_citations(UUID, UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_message_citations(UUID, UUID, UUID[]) TO authenticated;

COMMIT;
