-- Agent 2 M4: server-enforced MCP snapshot versioning (forward-only).
--
-- Before: create_mcp_snapshot (20261115000010) trusted the caller's p_version;
-- the route hard-coded 1, so a second snapshot of an endpoint failed on
-- UNIQUE (endpoint_id, version), and any caller could jump versions.
--
-- After: under a row lock on the endpoint, p_version must equal latest+1,
-- otherwise SQLSTATE 40001 (SNAPSHOT_VERSION_CONFLICT). Concurrent snapshots
-- serialize on the endpoint row, so versions are gap-free and unique per
-- endpoint. p_tools must be a JSON array. Snapshot + tools stay one
-- statement-level transaction: any failing tool insert (CHECK on name,
-- description, UNIQUE (snapshot_id, name)) rolls back the snapshot row too.
-- Signature, owner, SECURITY DEFINER and grants are unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_mcp_snapshot(
  p_organization_id UUID, p_endpoint_id UUID, p_version INTEGER, p_content_sha256 TEXT, p_tools jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_id UUID; v_latest INTEGER; t jsonb;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_TOOLS' USING ERRCODE = '22023';
  END IF;

  -- Serialize snapshots per endpoint; also proves the endpoint belongs to the org.
  PERFORM 1 FROM public.external_tool_endpoints
   WHERE id = p_endpoint_id AND organization_id = p_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(max(version), 0) INTO v_latest
    FROM public.external_tool_snapshots
   WHERE endpoint_id = p_endpoint_id AND organization_id = p_organization_id;
  IF p_version IS NULL OR p_version <> v_latest + 1 THEN
    RAISE EXCEPTION 'SNAPSHOT_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256)
  VALUES (p_organization_id, p_endpoint_id, p_version, p_content_sha256)
  RETURNING id INTO v_id;
  FOR t IN SELECT * FROM jsonb_array_elements(p_tools) LOOP
    INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class)
    VALUES (p_organization_id, v_id,
            t->>'name', COALESCE(t->>'description',''), COALESCE(t->'input_schema','{}'::jsonb), 'write');
  END LOOP;
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) TO authenticated;

-- Self-verification: abort the migration if the end state is not as intended.
DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure;
  IF position('FOR UPDATE' IN src) = 0 OR position('v_latest + 1' IN src) = 0 THEN
    RAISE EXCEPTION 'create_mcp_snapshot does not enforce versioning';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'create_mcp_snapshot must stay SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_mcp_snapshot grants are wrong';
  END IF;
END $$;

COMMIT;
