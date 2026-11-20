-- Workspace agents: instructions are confidential at the database level
-- (Agent 4, Q-9c; Agent 1 security review finding F-1).
--
-- Finding: agents_read lets every org member SELECT an organization agent,
-- including custom_agents.instructions. The API blanked the field for
-- non-editors, but a member calling PostgREST directly could read the system
-- prompt of every shared agent.
--
-- Fix (forward-only; earlier migrations are frozen):
-- * authenticated keeps row-level SELECT (agents_read unchanged) but loses
--   column SELECT on instructions. Every other column stays readable.
--   INSERT/UPDATE column grants are unchanged (owners still write it).
-- * Editors (private.can_edit_agent: owner, org member, not a viewer; the
--   same rule as the API's canEdit) read instructions only through
--   public.custom_agent_instructions(org, ids[]).
-- * Running an agent applies its instructions server-side for any reader:
--   public.custom_agent_run_instructions(org, user, agent) is executable only
--   by sso_control (server-only control role) and service_role, never by
--   anon, authenticated or PUBLIC.
-- * save_custom_agent (SECURITY INVOKER) read the column in its partial
--   UPDATE; it is replaced so it only writes it. Behaviour is otherwise
--   unchanged.
-- Prerequisite: the PostgREST login role must be a member of sso_control
-- (already required for MCP; see docs/workspace/operations.md).
BEGIN;

REVOKE SELECT ON public.custom_agents FROM authenticated;
GRANT SELECT (id, organization_id, owner_user_id, name, description, model_key, visibility, tools,
              conversation_starters, version, created_at, updated_at)
  ON public.custom_agents TO authenticated;

CREATE OR REPLACE FUNCTION public.save_custom_agent(p_organization_id uuid, p_agent_id uuid, p_values jsonb, p_collection_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $$
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
    -- F-1: the caller has no SELECT on instructions, so this function only
    -- ever writes that column and never reads it. Exactly one UPDATE runs
    -- either way, so custom_agents_touch bumps version once.
    IF p_values ? 'instructions' THEN
      UPDATE public.custom_agents a SET
        name = CASE WHEN p_values ? 'name' THEN p_values->>'name' ELSE a.name END,
        description = CASE WHEN p_values ? 'description' THEN p_values->>'description' ELSE a.description END,
        model_key = CASE WHEN p_values ? 'model_key' THEN p_values->>'model_key' ELSE a.model_key END,
        visibility = CASE WHEN p_values ? 'visibility' THEN p_values->>'visibility' ELSE a.visibility END,
        tools = CASE WHEN p_values ? 'tools' THEN p_values->'tools' ELSE a.tools END,
        conversation_starters = CASE WHEN p_values ? 'conversation_starters'
          THEN ARRAY(SELECT jsonb_array_elements_text(p_values->'conversation_starters')) ELSE a.conversation_starters END,
        instructions = p_values->>'instructions'
      WHERE a.id = v_id;
    ELSE
      UPDATE public.custom_agents a SET
        name = CASE WHEN p_values ? 'name' THEN p_values->>'name' ELSE a.name END,
        description = CASE WHEN p_values ? 'description' THEN p_values->>'description' ELSE a.description END,
        model_key = CASE WHEN p_values ? 'model_key' THEN p_values->>'model_key' ELSE a.model_key END,
        visibility = CASE WHEN p_values ? 'visibility' THEN p_values->>'visibility' ELSE a.visibility END,
        tools = CASE WHEN p_values ? 'tools' THEN p_values->'tools' ELSE a.tools END,
        conversation_starters = CASE WHEN p_values ? 'conversation_starters'
          THEN ARRAY(SELECT jsonb_array_elements_text(p_values->'conversation_starters')) ELSE a.conversation_starters END
      WHERE a.id = v_id;
    END IF;
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

-- Editors only; agents the caller cannot edit are silently omitted.
CREATE FUNCTION public.custom_agent_instructions(p_organization_id UUID, p_agent_ids UUID[])
RETURNS TABLE (agent_id UUID, instructions TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_agent_ids IS NULL OR cardinality(p_agent_ids) > 200 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT a.id, a.instructions FROM public.custom_agents a
    WHERE a.organization_id = p_organization_id AND a.id = ANY (p_agent_ids)
      AND private.can_edit_agent(a.id, v_uid);
END $$;
REVOKE ALL ON FUNCTION public.custom_agent_instructions(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.custom_agent_instructions(UUID, UUID[]) TO authenticated;

-- Server-only: the instructions applied when p_user_id runs the agent.
-- NULL when the agent is not in that org or that user cannot read it.
CREATE FUNCTION public.custom_agent_run_instructions(p_organization_id UUID, p_user_id UUID, p_agent_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT a.instructions FROM public.custom_agents a
  WHERE a.id = p_agent_id AND a.organization_id = p_organization_id
    AND p_user_id IS NOT NULL AND private.can_read_agent(a.id, p_user_id)
$$;
REVOKE ALL ON FUNCTION public.custom_agent_run_instructions(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_agent_run_instructions(UUID, UUID, UUID) TO sso_control, service_role;

COMMIT;
