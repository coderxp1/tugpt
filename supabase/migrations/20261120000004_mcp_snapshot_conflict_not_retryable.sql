-- Agent 2 (fix for Agent 1's M4 rejection): snapshot version conflicts must not be retryable.
--
-- Defect (20261120000002): create_mcp_snapshot raised SNAPSHOT_VERSION_CONFLICT with SQLSTATE 40001.
-- PostgREST treats 40001 as a transient serialization failure and re-runs the whole transaction with
-- the SAME arguments, which can never succeed. Measured against real PostgREST 14.14 + Postgres before
-- this migration: 10 parallel callers -> 1 x 200, 9 x 403 after ~29.5 s (the retries outlive the 30 s
-- bridge JWT, then sso.pre_request refuses), 116,979 rolled-back transactions; the route answered 500.
--
-- Fix: the conflict is raised with SQLSTATE PT409. PostgREST maps the PTxyz class straight to HTTP
-- status xyz and does not retry it. A lock wait is bounded (lock_timeout 5s) and a lock timeout is
-- reported as the same conflict, so a loser can never hang or loop.
--
-- Unchanged: signature, owner, SECURITY DEFINER, search_path, grants, the owner/admin check, the
-- endpoint/org row lock, the latest+1 rule (unique, gap-free versions; a failed attempt consumes no
-- version because the whole statement rolls back), tool validation via table constraints, and the
-- least-privilege default permission class. Forward-only: 20261120000002 is not edited.

CREATE OR REPLACE FUNCTION public.create_mcp_snapshot(
  p_organization_id UUID, p_endpoint_id UUID, p_version INTEGER, p_content_sha256 TEXT, p_tools jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '5s'
AS $$
DECLARE v_id UUID; v_latest INTEGER; v_found BOOLEAN; t jsonb;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_TOOLS' USING ERRCODE = '22023';
  END IF;

  -- Serialize snapshots per endpoint; also proves the endpoint belongs to the org.
  -- A lock that cannot be taken within lock_timeout is a conflict, not a retryable error.
  BEGIN
    PERFORM 1 FROM public.external_tool_endpoints
     WHERE id = p_endpoint_id AND organization_id = p_organization_id
     FOR UPDATE;
    v_found := FOUND;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SNAPSHOT_VERSION_CONFLICT' USING ERRCODE = 'PT409',
      DETAIL = 'another snapshot of this endpoint is in progress';
  END;
  IF NOT v_found THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(max(version), 0) INTO v_latest
    FROM public.external_tool_snapshots
   WHERE endpoint_id = p_endpoint_id AND organization_id = p_organization_id;
  IF p_version IS NULL OR p_version <> v_latest + 1 THEN
    RAISE EXCEPTION 'SNAPSHOT_VERSION_CONFLICT' USING ERRCODE = 'PT409';
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

-- Self-check: fail the migration rather than ship a retryable conflict.
DO $$
DECLARE src TEXT; bad TEXT;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure;
  IF position('PT409' IN src) = 0 OR position('40001' IN src) > 0
     OR position('FOR UPDATE' IN src) = 0 OR position('v_latest + 1' IN src) = 0 THEN
    RAISE EXCEPTION 'create_mcp_snapshot must raise a non-retryable PT409 conflict under the row lock';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'create_mcp_snapshot must stay SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_mcp_snapshot grants are wrong';
  END IF;
  -- No function in an API-reachable or helper schema may raise a SQLSTATE that PostgREST retries.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private', 'sso')
     AND p.prosrc ~* 'errcode\s*=\s*''(40001|40P01)''';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'functions raise a PostgREST-retryable SQLSTATE: %', bad;
  END IF;
END $$;
