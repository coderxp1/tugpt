-- Workspace chat: private per-user threads inside an organization, append-only
-- messages, the append-only audit of Connect tool calls made from chat, and the
-- @-picker's view of which capabilities the caller can actually use.
--
-- Authorization model (docs/workspace-chat.md):
--   * A thread belongs to exactly one (organization, user). Only that user, while
--     still a member of that organization, can read or write it. Owners/admins do
--     NOT read other people's chats; they read the tool-call audit instead.
--   * Messages carry organization_id and are bound to their thread by a composite
--     FK, so a message can never point at another tenant's thread.
--   * Messages are append-only for the browser-facing role (no UPDATE/DELETE);
--     deleting a thread cascades.
--   * The audit is written only through record_connect_tool_call(), which fixes
--     the actor to auth.uid() and checks membership. Nobody can update or delete it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat' CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  model_key TEXT NOT NULL CHECK (model_key ~ '^[a-z0-9][a-z0-9._:-]{0,79}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (id, organization_id)
);
CREATE INDEX chat_threads_owner_recent
  ON public.chat_threads (organization_id, owner_user_id, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL CHECK (char_length(content) <= 100000),
  model_key TEXT CHECK (model_key IS NULL OR model_key ~ '^[a-z0-9][a-z0-9._:-]{0,79}$'),
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mentions) = 'array' AND jsonb_array_length(mentions) <= 10),
  capability_key TEXT REFERENCES public.integration_capabilities(key),
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','error','stopped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES public.chat_threads (id, organization_id) ON DELETE CASCADE,
  CHECK (role = 'tool' OR capability_key IS NULL)
);
CREATE INDEX chat_messages_thread_time ON public.chat_messages (thread_id, created_at);

CREATE TABLE public.connect_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  thread_id UUID,
  capability_key TEXT NOT NULL REFERENCES public.integration_capabilities(key),
  provider_key TEXT REFERENCES public.integration_providers(key),
  connection_id UUID,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','denied','failed','requires_connection','duplicate_suppressed')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 600000),
  arguments_sha256 TEXT NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (thread_id, organization_id) REFERENCES public.chat_threads (id, organization_id) ON DELETE SET NULL (thread_id),
  FOREIGN KEY (connection_id, organization_id) REFERENCES public.connected_accounts (id, organization_id) ON DELETE SET NULL (connection_id)
);
CREATE INDEX connect_tool_calls_org_time ON public.connect_tool_calls (organization_id, created_at DESC);

ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connect_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connect_tool_calls FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.chat_threads, public.chat_messages, public.connect_tool_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.chat_threads TO authenticated;
GRANT UPDATE (title, model_key, archived_at, updated_at) ON public.chat_threads TO authenticated;
GRANT SELECT, INSERT ON public.chat_messages TO authenticated;
GRANT SELECT ON public.connect_tool_calls TO authenticated;

CREATE POLICY threads_owner ON public.chat_threads FOR ALL TO authenticated
  USING (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()))
  WITH CHECK (owner_user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()));

CREATE POLICY messages_owner_read ON public.chat_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.chat_threads t
                 WHERE t.id = thread_id AND t.organization_id = chat_messages.organization_id
                   AND t.owner_user_id = auth.uid())
         AND private.is_org_member(organization_id, auth.uid()));
CREATE POLICY messages_owner_append ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.chat_threads t
                      WHERE t.id = thread_id AND t.organization_id = chat_messages.organization_id
                        AND t.owner_user_id = auth.uid() AND t.archived_at IS NULL)
              AND private.is_org_member(organization_id, auth.uid()));

-- Actors see their own calls; owners/admins see the organization's.
CREATE POLICY tool_calls_read ON public.connect_tool_calls FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()) AND (
    actor_user_id = auth.uid()
    OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::organization_role[])));

CREATE OR REPLACE FUNCTION public.record_connect_tool_call(
  p_organization_id UUID, p_thread_id UUID, p_capability_key TEXT, p_provider_key TEXT,
  p_connection_id UUID, p_outcome TEXT, p_error_code TEXT, p_duration_ms INTEGER, p_arguments_sha256 TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_actor UUID := auth.uid(); v_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT private.is_org_member(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'CHAT_NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;
  IF p_thread_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.chat_threads t WHERE t.id = p_thread_id
         AND t.organization_id = p_organization_id AND t.owner_user_id = v_actor) THEN
    RAISE EXCEPTION 'CHAT_THREAD_NOT_OWNED' USING ERRCODE = '42501';
  END IF;
  IF p_connection_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.connected_accounts a WHERE a.id = p_connection_id
         AND a.organization_id = p_organization_id
         AND (a.owner_type = 'organization' OR a.owner_user_id = v_actor)) THEN
    RAISE EXCEPTION 'CHAT_CONNECTION_NOT_USABLE' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.connect_tool_calls (organization_id, actor_user_id, thread_id, capability_key, provider_key,
    connection_id, outcome, error_code, duration_ms, arguments_sha256)
  VALUES (p_organization_id, v_actor, p_thread_id, p_capability_key, p_provider_key,
    p_connection_id, p_outcome, p_error_code, p_duration_ms, p_arguments_sha256)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.record_connect_tool_call(UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_connect_tool_call(UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT,INTEGER,TEXT) TO authenticated;

-- The @-picker. Invoker rights: it sees exactly what RLS lets the caller see,
-- and only connections the caller may USE (org-owned, or their own).
CREATE OR REPLACE FUNCTION public.list_chat_capabilities(p_organization_id UUID)
RETURNS TABLE (capability_key TEXT, provider_key TEXT, provider_name TEXT, description TEXT,
               permission_class TEXT, state TEXT, connection_id UUID)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT pc.capability_key, p.key, p.display_name, c.description, c.permission_class,
    CASE
      WHEN NOT p.is_available THEN 'not_available'
      WHEN pol.allowed_provider_keys IS NOT NULL AND NOT (p.key = ANY(pol.allowed_provider_keys)) THEN 'disabled_by_policy'
      WHEN conn.id IS NOT NULL THEN 'connected'
      WHEN NOT p.supports_org_connections AND COALESCE(pol.allow_user_connections, true) = false THEN 'disabled_by_policy'
      ELSE 'requires_connection'
    END,
    conn.id
  FROM public.integration_provider_capabilities pc
  JOIN public.integration_providers p ON p.key = pc.provider_key
  JOIN public.integration_capabilities c ON c.key = pc.capability_key
  LEFT JOIN public.organization_integration_policies pol ON pol.organization_id = p_organization_id
  LEFT JOIN LATERAL (
    SELECT a.id FROM public.connected_accounts a
    WHERE a.organization_id = p_organization_id AND a.provider_key = p.key AND a.status = 'connected'
      AND a.scopes @> pc.required_scopes
      AND (a.owner_type = 'organization' OR a.owner_user_id = auth.uid())
    ORDER BY (a.owner_type = 'user') DESC, a.id LIMIT 1) conn ON true
  WHERE private.is_org_member(p_organization_id, auth.uid())
  ORDER BY p.display_name, pc.capability_key
$$;
REVOKE ALL ON FUNCTION public.list_chat_capabilities(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_chat_capabilities(UUID) TO authenticated;

-- Microsoft 365 joins the catalogue unavailable: there is no runtime adapter yet,
-- so the picker must say "not available" rather than offer it.
INSERT INTO public.integration_providers (key, display_name, auth_kind, supports_user_connections, supports_org_connections)
VALUES ('microsoft', 'Microsoft 365', 'oauth2', true, true);
INSERT INTO public.integration_provider_capabilities (provider_key, capability_key, required_scopes)
VALUES ('microsoft', 'calendar.find_availability', ARRAY['https://graph.microsoft.com/Calendars.ReadBasic']);

COMMIT;
