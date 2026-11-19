-- Workspace custom agents (Agent 4, Q-6 hardening).
--
-- 1. Editing is owner-only in the database too. 20261120100004 let org
--    owners/admins UPDATE any organization agent and add or remove its
--    knowledge links, while the API (PATCH, link, unlink, save_custom_agent)
--    has always been owner-only. An admin token used directly against
--    PostgREST could therefore change another member's agent, including its
--    instructions, which the admin cannot even read through the API. The
--    database now matches the API: only the owner (an org member who is not a
--    viewer) may change an agent or its links. DELETE stays owner-or-admin
--    (moderation: an admin can remove an org agent, not rewrite it).
--
-- 2. public.link_custom_agent_collection: the single-link endpoint counted the
--    visible links and inserted afterwards, so parallel requests could exceed
--    the 10-link API limit (only the 20-row database cap held). The function
--    locks the agent row first, the same lock save_custom_agent takes, so
--    count and insert are serialised per agent across both entry points.
--
-- 20261120100004 is frozen; this migration only replaces its policies.
BEGIN;

CREATE FUNCTION private.can_edit_agent(p_agent UUID, p_user UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.custom_agents a
    WHERE a.id = p_agent AND p_user IS NOT NULL
      AND a.owner_user_id = p_user
      AND private.is_org_member(a.organization_id, p_user)
      AND NOT private.has_org_role(a.organization_id, p_user, ARRAY['viewer']::public.organization_role[]))
$$;
REVOKE ALL ON FUNCTION private.can_edit_agent(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_edit_agent(UUID,UUID) TO authenticated;

DROP POLICY agents_update ON public.custom_agents;
CREATE POLICY agents_update ON public.custom_agents FOR UPDATE TO authenticated
  USING (private.can_edit_agent(id, auth.uid()))
  WITH CHECK (private.is_org_member(organization_id, auth.uid())
    AND (visibility = 'private'
         OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])));

DROP POLICY agent_collections_insert ON public.custom_agent_collections;
CREATE POLICY agent_collections_insert ON public.custom_agent_collections FOR INSERT TO authenticated
  WITH CHECK (linked_by = auth.uid()
    AND private.can_edit_agent(agent_id, auth.uid())
    AND private.can_read_collection(collection_id, auth.uid()));

DROP POLICY agent_collections_delete ON public.custom_agent_collections;
CREATE POLICY agent_collections_delete ON public.custom_agent_collections FOR DELETE TO authenticated
  USING (private.can_edit_agent(agent_id, auth.uid()));

-- Returns true when a link was added, false when it already existed.
-- Errors: AGENT_NOT_FOUND / COLLECTION_NOT_FOUND (P0002; missing, not the
-- caller's, or unreadable: no enumeration), TOO_MANY_COLLECTIONS (22023).
CREATE FUNCTION public.link_custom_agent_collection(
  p_organization_id UUID,
  p_agent_id UUID,
  p_collection_id UUID)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_n INTEGER;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL OR p_agent_id IS NULL OR p_collection_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Owner only (UPDATE policy applies to FOR UPDATE); the lock serialises
  -- concurrent links and saves of this agent.
  PERFORM 1 FROM public.custom_agents a
    WHERE a.id = p_agent_id AND a.organization_id = p_organization_id AND a.owner_user_id = v_uid
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- RLS on knowledge_collections: only collections the caller can read.
  PERFORM 1 FROM public.knowledge_collections c
    WHERE c.id = p_collection_id AND c.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.custom_agent_collections l
             WHERE l.agent_id = p_agent_id AND l.collection_id = p_collection_id) THEN
    RETURN false;
  END IF;
  -- The API limit counts the links the caller can see (as save_custom_agent does).
  SELECT count(*) INTO v_n FROM public.custom_agent_collections l
    WHERE l.agent_id = p_agent_id AND l.organization_id = p_organization_id
      AND EXISTS (SELECT 1 FROM public.knowledge_collections c WHERE c.id = l.collection_id);
  IF v_n >= 10 THEN
    RAISE EXCEPTION 'TOO_MANY_COLLECTIONS' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by)
    VALUES (p_agent_id, p_collection_id, p_organization_id, v_uid);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.link_custom_agent_collection(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_custom_agent_collection(UUID, UUID, UUID) TO authenticated;

COMMIT;
