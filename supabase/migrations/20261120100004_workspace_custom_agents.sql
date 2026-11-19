-- Custom agents (Agent 4): saved instructions + model + tool selection +
-- knowledge collections, run through the existing chat runtime.
--
-- Security model:
--  * An agent is configuration, not a grant. Running an agent never gives the
--    caller access to tools or collections they could not use themselves:
--    tools are intersected with the caller's own connected capabilities and
--    retrieval runs under the caller's RLS (can_read_collection).
--  * Visibility mirrors knowledge collections: private (owner only) or
--    organization (all members can read/run); only owners/admins publish to the
--    organization, viewers cannot create agents.
--  * Linking a collection requires write access to the agent and read access
--    to the collection, so an agent cannot be used to discover collection ids.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Tool selection: array of {capability, provider} identifiers, the same shape
-- the chat runtime's @-mentions use. Keys only; no connection ids or secrets.
CREATE OR REPLACE FUNCTION private.valid_agent_tools(p_tools JSONB)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(p_tools) = 'array'
    AND jsonb_array_length(p_tools) <= 50
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tools) t(v)
      WHERE jsonb_typeof(t.v) <> 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(t.v)) <> 2
         OR jsonb_typeof(t.v->'capability') IS DISTINCT FROM 'string'
         OR jsonb_typeof(t.v->'provider') IS DISTINCT FROM 'string'
         OR (t.v->>'capability') !~ '^[a-z0-9][a-z0-9._:-]{0,79}$'
         OR (t.v->>'provider') !~ '^[a-z0-9][a-z0-9._:-]{0,79}$')
    AND (SELECT count(*) FROM jsonb_array_elements(p_tools))
      = (SELECT count(DISTINCT (t.v->>'capability', t.v->>'provider')) FROM jsonb_array_elements(p_tools) t(v))
$$;
REVOKE ALL ON FUNCTION private.valid_agent_tools(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.valid_agent_tools(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.valid_conversation_starters(p_starters TEXT[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(array_length(p_starters, 1), 0) <= 6
    AND NOT EXISTS (SELECT 1 FROM unnest(p_starters) s(v)
      WHERE s.v IS NULL OR char_length(btrim(s.v)) NOT BETWEEN 1 AND 300 OR s.v ~ '[[:cntrl:]]')
$$;
REVOKE ALL ON FUNCTION private.valid_conversation_starters(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.valid_conversation_starters(TEXT[]) TO authenticated, service_role;

CREATE TABLE public.custom_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 20000),
  model_key TEXT CHECK (model_key IS NULL OR model_key ~ '^[a-z0-9][a-z0-9._:-]{0,79}$'),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','organization')),
  tools JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (private.valid_agent_tools(tools)),
  conversation_starters TEXT[] NOT NULL DEFAULT '{}' CHECK (private.valid_conversation_starters(conversation_starters)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE INDEX custom_agents_org ON public.custom_agents (organization_id, updated_at DESC);
CREATE INDEX custom_agents_owner ON public.custom_agents (owner_user_id);

CREATE OR REPLACE FUNCTION private.can_read_agent(p_agent UUID, p_user UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.custom_agents a
    WHERE a.id = p_agent AND p_user IS NOT NULL
      AND private.is_org_member(a.organization_id, p_user)
      AND (a.owner_user_id = p_user OR a.visibility = 'organization'))
$$;
CREATE OR REPLACE FUNCTION private.can_write_agent(p_agent UUID, p_user UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.custom_agents a
    WHERE a.id = p_agent AND p_user IS NOT NULL
      AND private.is_org_member(a.organization_id, p_user)
      AND NOT private.has_org_role(a.organization_id, p_user, ARRAY['viewer']::public.organization_role[])
      AND (a.owner_user_id = p_user
           OR (a.visibility = 'organization'
               AND private.has_org_role(a.organization_id, p_user, ARRAY['owner','admin']::public.organization_role[]))))
$$;
REVOKE ALL ON FUNCTION private.can_read_agent(UUID,UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.can_write_agent(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_read_agent(UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_write_agent(UUID,UUID) TO authenticated;

ALTER TABLE public.custom_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_agents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_agents FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.custom_agents TO authenticated;
GRANT INSERT (id, organization_id, owner_user_id, name, description, instructions, model_key, visibility, tools, conversation_starters)
  ON public.custom_agents TO authenticated;
GRANT UPDATE (name, description, instructions, model_key, visibility, tools, conversation_starters)
  ON public.custom_agents TO authenticated;

CREATE POLICY agents_read ON public.custom_agents FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
    AND (owner_user_id = auth.uid() OR visibility = 'organization'));
CREATE POLICY agents_insert ON public.custom_agents FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid()
    AND private.is_org_member(organization_id, auth.uid())
    AND NOT private.has_org_role(organization_id, auth.uid(), ARRAY['viewer']::public.organization_role[])
    AND (visibility = 'private'
         OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])));
CREATE POLICY agents_update ON public.custom_agents FOR UPDATE TO authenticated
  USING (private.can_write_agent(id, auth.uid()))
  WITH CHECK (private.is_org_member(organization_id, auth.uid())
    AND (visibility = 'private'
         OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])));
CREATE POLICY agents_delete ON public.custom_agents FOR DELETE TO authenticated
  USING (private.can_write_agent(id, auth.uid()));

-- Server-maintained version/updated_at; immutable identity columns.
CREATE OR REPLACE FUNCTION private.custom_agents_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.owner_user_id <> OLD.owner_user_id THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN' USING ERRCODE = '42501';
  END IF;
  IF (NEW.name, NEW.description, NEW.instructions, NEW.model_key, NEW.visibility, NEW.tools, NEW.conversation_starters)
     IS DISTINCT FROM
     (OLD.name, OLD.description, OLD.instructions, OLD.model_key, OLD.visibility, OLD.tools, OLD.conversation_starters) THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  ELSE
    NEW.version := OLD.version;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.custom_agents_touch() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER custom_agents_touch BEFORE UPDATE ON public.custom_agents
  FOR EACH ROW EXECUTE FUNCTION private.custom_agents_touch();

CREATE TABLE public.custom_agent_collections (
  agent_id UUID NOT NULL,
  collection_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  linked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, collection_id),
  FOREIGN KEY (agent_id, organization_id) REFERENCES public.custom_agents(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id, organization_id) REFERENCES public.knowledge_collections(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX custom_agent_collections_collection ON public.custom_agent_collections (collection_id);
ALTER TABLE public.custom_agent_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_agent_collections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_agent_collections FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.custom_agent_collections TO authenticated;
GRANT INSERT (agent_id, collection_id, organization_id, linked_by) ON public.custom_agent_collections TO authenticated;

-- Readers of the agent see which collections it uses (ids only); actual
-- content is still filtered by can_read_collection at retrieval time.
CREATE POLICY agent_collections_read ON public.custom_agent_collections FOR SELECT TO authenticated
  USING (private.can_read_agent(agent_id, auth.uid()));
CREATE POLICY agent_collections_insert ON public.custom_agent_collections FOR INSERT TO authenticated
  WITH CHECK (linked_by = auth.uid()
    AND private.can_write_agent(agent_id, auth.uid())
    AND private.can_read_collection(collection_id, auth.uid()));
CREATE POLICY agent_collections_delete ON public.custom_agent_collections FOR DELETE TO authenticated
  USING (private.can_write_agent(agent_id, auth.uid()));

-- Limit per agent (keeps retrieval bounded; search accepts at most 20 ids).
CREATE OR REPLACE FUNCTION private.custom_agent_collections_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM public.custom_agents a WHERE a.id = NEW.agent_id FOR UPDATE;
  IF (SELECT count(*) FROM public.custom_agent_collections c WHERE c.agent_id = NEW.agent_id) >= 20 THEN
    RAISE EXCEPTION 'TOO_MANY_COLLECTIONS' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.custom_agent_collections_limit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER custom_agent_collections_limit BEFORE INSERT ON public.custom_agent_collections
  FOR EACH ROW EXECUTE FUNCTION private.custom_agent_collections_limit();

-- Threads started from an agent remember it; deleting the agent keeps the
-- conversation (agent_id becomes NULL, organization_id is untouched).
ALTER TABLE public.chat_threads ADD COLUMN agent_id UUID;
ALTER TABLE public.chat_threads ADD CONSTRAINT chat_threads_agent_fk
  FOREIGN KEY (agent_id, organization_id) REFERENCES public.custom_agents(id, organization_id) ON DELETE SET NULL (agent_id);
CREATE INDEX chat_threads_agent ON public.chat_threads (agent_id) WHERE agent_id IS NOT NULL;
GRANT INSERT (agent_id) ON public.chat_threads TO authenticated;
CREATE POLICY threads_agent_readable ON public.chat_threads AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (agent_id IS NULL OR private.can_read_agent(agent_id, auth.uid()));

-- Audit: who created/changed/deleted which agent; never the instructions text.
CREATE OR REPLACE FUNCTION private.custom_agents_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'custom_agents' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM private.workspace_audit(NEW.organization_id, 'workspace.agent.created', 'custom_agent',
        jsonb_build_object('agent_id', NEW.id, 'visibility', NEW.visibility));
    ELSIF TG_OP = 'DELETE' THEN
      PERFORM private.workspace_audit(OLD.organization_id, 'workspace.agent.deleted', 'custom_agent',
        jsonb_build_object('agent_id', OLD.id));
      RETURN OLD;
    ELSIF NEW.version <> OLD.version THEN
      PERFORM private.workspace_audit(NEW.organization_id, 'workspace.agent.updated', 'custom_agent',
        jsonb_build_object('agent_id', NEW.id, 'version', NEW.version,
          'visibility_changed', NEW.visibility IS DISTINCT FROM OLD.visibility,
          'tools_changed', NEW.tools IS DISTINCT FROM OLD.tools,
          'instructions_changed', NEW.instructions IS DISTINCT FROM OLD.instructions));
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM private.workspace_audit(NEW.organization_id, 'workspace.agent.collection_linked', 'custom_agent',
      jsonb_build_object('agent_id', NEW.agent_id, 'collection_id', NEW.collection_id));
    RETURN NEW;
  END IF;
  PERFORM private.workspace_audit(OLD.organization_id, 'workspace.agent.collection_unlinked', 'custom_agent',
    jsonb_build_object('agent_id', OLD.agent_id, 'collection_id', OLD.collection_id));
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION private.custom_agents_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER custom_agents_workspace_audit AFTER INSERT OR UPDATE OR DELETE
  ON public.custom_agents FOR EACH ROW EXECUTE FUNCTION private.custom_agents_audit();
CREATE TRIGGER custom_agent_collections_workspace_audit AFTER INSERT OR DELETE
  ON public.custom_agent_collections FOR EACH ROW EXECUTE FUNCTION private.custom_agents_audit();

COMMIT;
