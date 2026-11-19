-- Agent 2 (fix for Agent 1's M4 re-test): create_mcp_snapshot's lock waits must end before the app gives up.
--
-- Defect (20261120000004): the function waited up to lock_timeout 5s for the endpoint row, and the web
-- tier aborts every PostgREST request after 5 s (apps/web/src/lib/supabase/server.ts,
-- POSTGREST_REQUEST_TIMEOUT_MS). With the row held by another transaction the app aborted first, never saw
-- the PT409 conflict, and the route answered 500 (reproduced through real Next -> PostgREST 14.14 ->
-- Postgres: 500 INTERNAL at 5.13 s). A lock other than the row (e.g. DDL holding external_tools) raised a
-- raw 55P03 that no caller maps: 500 at 5.12 s.
--
-- Fix:
--   * lock_timeout 2s: every lock wait inside the function ends >= 2 s before the 5 s app timeout.
--   * endpoint row lock not available  -> PT409 SNAPSHOT_VERSION_CONFLICT (unchanged; HTTP 409).
--   * any other lock not available     -> PT503 SNAPSHOT_STORE_BUSY (new; HTTP 503, PostgREST does not retry
--                                         PTxyz and the client does not retry a POST).
-- A failed call rolls back as a whole: no snapshot row, no tool rows, no version consumed.
--
-- Unchanged: signature, owner, SECURITY DEFINER, search_path, grants, the owner/admin check, the endpoint/org
-- row lock, the latest+1 rule, tool validation via table constraints, least-privilege default class.
-- Forward-only: 20261120000002 and 20261120000004 are not edited.

CREATE OR REPLACE FUNCTION public.create_mcp_snapshot(
  p_organization_id UUID, p_endpoint_id UUID, p_version INTEGER, p_content_sha256 TEXT, p_tools jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $$
DECLARE v_id UUID; v_latest INTEGER; v_found BOOLEAN; t jsonb;
BEGIN
  -- Outer block: any lock that cannot be taken within lock_timeout, other than the endpoint row (handled
  -- in the inner block), means the store is briefly locked (typically DDL): busy, not a version conflict.
  BEGIN
    IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_TOOLS' USING ERRCODE = '22023';
    END IF;

    -- Serialize snapshots per endpoint; also proves the endpoint belongs to the org.
    -- A row lock that cannot be taken within lock_timeout is a conflict, not a retryable error.
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
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SNAPSHOT_STORE_BUSY' USING ERRCODE = 'PT503',
      DETAIL = 'the snapshot store is locked; retry shortly';
  END;
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_mcp_snapshot(UUID,UUID,INTEGER,TEXT,jsonb) TO authenticated;

-- Self-check: fail the migration rather than ship a lock budget the app cannot observe.
DO $$
DECLARE src TEXT; cfg TEXT[]; lt INTERVAL; bad TEXT;
BEGIN
  SELECT prosrc, proconfig INTO src, cfg FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure;
  SELECT substring(c FROM 'lock_timeout=(.*)')::interval INTO lt FROM unnest(cfg) c WHERE c LIKE 'lock_timeout=%';
  -- 5 s app request timeout (POSTGREST_REQUEST_TIMEOUT_MS) minus a 2 s margin.
  IF lt IS NULL OR lt > interval '3 seconds' THEN
    RAISE EXCEPTION 'create_mcp_snapshot lock_timeout must be <= 3s (app aborts PostgREST requests at 5s), got %', lt;
  END IF;
  IF position('PT409' IN src) = 0 OR position('PT503' IN src) = 0 OR position('40001' IN src) > 0
     OR position('FOR UPDATE' IN src) = 0 OR position('v_latest + 1' IN src) = 0 THEN
    RAISE EXCEPTION 'create_mcp_snapshot must keep PT409 under the row lock and report other lock timeouts as PT503';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'create_mcp_snapshot must stay SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_mcp_snapshot grants are wrong';
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private', 'sso')
     AND p.prosrc ~* 'errcode\s*=\s*''(40001|40P01)''';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'functions raise a PostgREST-retryable SQLSTATE: %', bad;
  END IF;
END $$;
