-- V7 + A1/A2: narrow member read access and move writes to SECURITY DEFINER
-- RPCs (so the routes can use the authenticated caller's client under the
-- SSO/PostgREST front, where createAdminSupabaseClient refuses).

-- ---------------------------------------------------------------------------
-- V7: members discover only ACTIVE endpoints and the APPROVED tool set, and
-- never see connection URLs or credential configuration. Owner/admin still
-- manage via the SECURITY DEFINER RPCs below (service-role inside).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS ext_read ON public.external_tool_endpoints;
CREATE POLICY ext_read ON public.external_tool_endpoints FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()) AND status = 'active');

DROP POLICY IF EXISTS ext_read ON public.external_tool_snapshots;
CREATE POLICY ext_read ON public.external_tool_snapshots FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
         AND approved_at IS NOT NULL
         AND revoked_at IS NULL);

DROP POLICY IF EXISTS ext_read ON public.external_tools;
CREATE POLICY ext_read ON public.external_tools FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
         AND EXISTS (
           SELECT 1 FROM public.external_tool_snapshots s
           WHERE s.id = snapshot_id AND s.approved_at IS NOT NULL AND s.revoked_at IS NULL
         ));

-- Hide connection URL and credential configuration from ordinary members.
REVOKE SELECT (url, auth_connection_id) ON public.external_tool_endpoints FROM authenticated;

-- ---------------------------------------------------------------------------
-- Trusted list for the runtime: active endpoints' newest approved snapshot
-- tools, including the url (needed to execute, never returned to the browser).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_active_mcp_tools(UUID);
CREATE OR REPLACE FUNCTION public.list_active_mcp_tools(p_organization_id UUID)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'endpointId', x->>'name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'endpointId', e.id,
      'url', e.url,
      'name', t.name,
      'description', t.description,
      'inputSchema', t.input_schema,
      'permissionClass', t.permission_class
    ) AS x
    FROM public.external_tool_endpoints e
    JOIN LATERAL (
      SELECT s.id FROM public.external_tool_snapshots s
      WHERE s.endpoint_id = e.id AND s.organization_id = p_organization_id
        AND s.approved_at IS NOT NULL AND s.revoked_at IS NULL
      ORDER BY s.version DESC LIMIT 1
    ) latest ON true
    JOIN public.external_tools t ON t.snapshot_id = latest.id AND t.organization_id = p_organization_id
    WHERE e.organization_id = p_organization_id AND e.status = 'active'
      AND private.is_org_member(p_organization_id, auth.uid())
  ) sub;
$$;
REVOKE ALL ON FUNCTION public.list_active_mcp_tools(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_active_mcp_tools(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Write RPCs (owner/admin only).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.register_mcp_endpoint(UUID,TEXT,TEXT);
CREATE OR REPLACE FUNCTION public.register_mcp_endpoint(
  p_organization_id UUID, p_url TEXT, p_display_name TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.external_tool_endpoints (organization_id, kind, url, display_name, status, created_by)
  VALUES (p_organization_id, 'mcp', p_url, p_display_name, 'pending', auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.register_mcp_endpoint(UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_mcp_endpoint(UUID,TEXT,TEXT) TO authenticated;

DROP FUNCTION IF EXISTS public.activate_mcp_endpoint(UUID,UUID);
CREATE OR REPLACE FUNCTION public.activate_mcp_endpoint(p_organization_id UUID, p_endpoint_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.external_tool_endpoints SET status = 'active'
  WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.activate_mcp_endpoint(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_mcp_endpoint(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.deactivate_mcp_endpoint(UUID,UUID);
CREATE OR REPLACE FUNCTION public.deactivate_mcp_endpoint(p_organization_id UUID, p_endpoint_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.external_tool_endpoints SET status = 'disabled'
  WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.deactivate_mcp_endpoint(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deactivate_mcp_endpoint(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.delete_mcp_endpoint(UUID,UUID);
CREATE OR REPLACE FUNCTION public.delete_mcp_endpoint(p_organization_id UUID, p_endpoint_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.external_tool_endpoints WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_mcp_endpoint(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_mcp_endpoint(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb);
CREATE OR REPLACE FUNCTION public.create_mcp_snapshot(
  p_organization_id UUID, p_endpoint_id UUID, p_version INTEGER, p_content_sha256 TEXT, p_tools jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_id UUID; t jsonb;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256)
  VALUES (p_organization_id, p_endpoint_id, p_version, p_content_sha256)
  RETURNING id INTO v_id;
  IF jsonb_typeof(p_tools) = 'array' THEN
    FOR t IN SELECT * FROM jsonb_array_elements(p_tools) LOOP
      INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class)
      VALUES (p_organization_id, v_id,
              t->>'name', COALESCE(t->>'description',''), COALESCE(t->'input_schema','{}'::jsonb), 'write');
    END LOOP;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.approve_mcp_snapshot(UUID,UUID,jsonb);
CREATE OR REPLACE FUNCTION public.approve_mcp_snapshot(
  p_organization_id UUID, p_snapshot_id UUID, p_tools jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE t jsonb;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_tools) = 'array' THEN
    FOR t IN SELECT * FROM jsonb_array_elements(p_tools) LOOP
      UPDATE public.external_tools
      SET permission_class = CASE
        WHEN t->>'permissionClass' IN ('read','write','irreversible','financial') THEN t->>'permissionClass'
        ELSE 'write' END
      WHERE organization_id = p_organization_id
        AND snapshot_id = p_snapshot_id
        AND name = t->>'name';
    END LOOP;
  END IF;
  UPDATE public.external_tool_snapshots
  SET approved_by = auth.uid(), approved_at = now()
  WHERE id = p_snapshot_id AND organization_id = p_organization_id AND approved_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_mcp_snapshot(UUID,UUID,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_mcp_snapshot(UUID,UUID,jsonb) TO authenticated;
