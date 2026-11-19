-- Workspace custom agents (Agent 4): save fields and knowledge links in one
-- transaction (Q-6, C-1 contract).
--
-- The agent builder sends the whole agent, including collectionIds, in one
-- POST or PATCH. Saving the fields and replacing the links in separate
-- PostgREST requests could leave a half-saved agent, so both happen here.
--
-- * SECURITY INVOKER: every statement runs as the caller, so the existing
--   RLS policies, column grants, CHECK constraints, the version/updated_at
--   touch trigger and the per-agent link limit trigger all still apply. This
--   function adds rules; it never bypasses one.
-- * Editing is owner-only (C-1: "PATCH owner only; others 404"). RLS would
--   also let an org owner/admin update an organization agent; through this
--   function they get NOT_FOUND, like anyone else who is not the owner.
--   Deleting is unchanged (owner or org owner/admin, via RLS).
-- * p_collection_ids NULL leaves the links alone. Otherwise it is the complete
--   set of collections the CALLER wants linked: every id must be a collection
--   the caller can read in this organization (unknown and unreadable ids get
--   the same INVALID_COLLECTION, so existence does not leak), at most 10.
--   Links to collections the caller cannot read are left untouched: the
--   caller never saw them and cannot remove what they cannot see.
-- * p_values holds only column names (name, description, instructions,
--   model_key, visibility, tools, conversation_starters); absent keys keep
--   the stored value. Shape and catalogue checks (model in the chat
--   catalogue, C-1 length limits) are done by the API before the call.
BEGIN;

CREATE FUNCTION public.save_custom_agent(
  p_organization_id UUID,
  p_agent_id UUID,
  p_values JSONB,
  p_collection_ids UUID[] DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id UUID;
  v_ids UUID[];
  v_n INTEGER;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_values) k
                WHERE k NOT IN ('name','description','instructions','model_key','visibility','tools','conversation_starters'))
     OR (p_values ? 'conversation_starters' AND jsonb_typeof(p_values->'conversation_starters') <> 'array')
     OR (p_values ? 'tools' AND jsonb_typeof(p_values->'tools') <> 'array') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;

  IF p_collection_ids IS NOT NULL THEN
    IF array_position(p_collection_ids, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
    END IF;
    v_ids := ARRAY(SELECT DISTINCT x FROM unnest(p_collection_ids) x);
    IF cardinality(v_ids) > 10 THEN
      RAISE EXCEPTION 'TOO_MANY_COLLECTIONS' USING ERRCODE = '22023';
    END IF;
    -- RLS on knowledge_collections: only collections the caller can read count.
    SELECT count(*) INTO v_n FROM public.knowledge_collections c
      WHERE c.id = ANY (v_ids) AND c.organization_id = p_organization_id;
    IF v_n <> cardinality(v_ids) THEN
      RAISE EXCEPTION 'INVALID_COLLECTION' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_agent_id IS NULL THEN
    INSERT INTO public.custom_agents (organization_id, owner_user_id, name, description, instructions, model_key,
                                      visibility, tools, conversation_starters)
    VALUES (p_organization_id, v_uid, p_values->>'name', p_values->>'description', COALESCE(p_values->>'instructions', ''),
            p_values->>'model_key', COALESCE(p_values->>'visibility', 'private'), COALESCE(p_values->'tools', '[]'::jsonb),
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_values->'conversation_starters', '[]'::jsonb))))
    RETURNING id INTO v_id;
  ELSE
    -- Owner only; the row lock serialises concurrent saves of the same agent.
    SELECT a.id INTO v_id FROM public.custom_agents a
      WHERE a.id = p_agent_id AND a.organization_id = p_organization_id AND a.owner_user_id = v_uid
      FOR UPDATE;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.custom_agents a SET
      name = CASE WHEN p_values ? 'name' THEN p_values->>'name' ELSE a.name END,
      description = CASE WHEN p_values ? 'description' THEN p_values->>'description' ELSE a.description END,
      instructions = CASE WHEN p_values ? 'instructions' THEN p_values->>'instructions' ELSE a.instructions END,
      model_key = CASE WHEN p_values ? 'model_key' THEN p_values->>'model_key' ELSE a.model_key END,
      visibility = CASE WHEN p_values ? 'visibility' THEN p_values->>'visibility' ELSE a.visibility END,
      tools = CASE WHEN p_values ? 'tools' THEN p_values->'tools' ELSE a.tools END,
      conversation_starters = CASE WHEN p_values ? 'conversation_starters'
        THEN ARRAY(SELECT jsonb_array_elements_text(p_values->'conversation_starters')) ELSE a.conversation_starters END
    WHERE a.id = v_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN -- defensive: FOR UPDATE above already applies the UPDATE policy
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_ids IS NOT NULL THEN
    -- Remove the caller-visible links that are no longer wanted; links to
    -- collections the caller cannot read are invisible here and stay.
    DELETE FROM public.custom_agent_collections l
      WHERE l.agent_id = v_id AND l.organization_id = p_organization_id
        AND NOT (l.collection_id = ANY (v_ids))
        AND EXISTS (SELECT 1 FROM public.knowledge_collections c WHERE c.id = l.collection_id);
    INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by)
      SELECT v_id, x, p_organization_id, v_uid FROM unnest(v_ids) x
      WHERE NOT EXISTS (SELECT 1 FROM public.custom_agent_collections l WHERE l.agent_id = v_id AND l.collection_id = x);
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.save_custom_agent(UUID, UUID, JSONB, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_custom_agent(UUID, UUID, JSONB, UUID[]) TO authenticated;

COMMIT;
