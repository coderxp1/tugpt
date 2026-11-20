-- 20261120200001: M9 acceptance follow-up (Agent 1 findings F-M9-2, F-M9-3, F-M9-1 database side).
--
-- Forward-only. Does not edit 20261120000001..0006 or any other workstream's migration. The ID starts a new
-- 2026112020xxxx block so it sorts after both the Connect line (20261120000001..0006) and the workspace/Q-9
-- line (20261120100001..0011).
--
--   F-M9-2  The legacy, key-less public.create_mcp_snapshot(...) is no longer executable by any API role
--           (PUBLIC, anon, authenticated, service_role). The app stopped calling it in 0006; it stayed granted,
--           so a direct PostgREST /rpc call could still bypass Idempotency-Key replay. The function body is
--           kept (no DROP: forward-only and nothing depends on removing it) and marked deprecated.
--           create_mcp_snapshot_idempotent is the only supported write path.
--   F-M9-3  create_mcp_snapshot_idempotent checks endpoint ownership (endpoint id + caller's org) before it
--           takes the per-(endpoint, key) advisory lock, so another tenant gets an immediate NOT_FOUND and can
--           never wait on, or see "in progress" for, a request running in a foreign tenant.
--           get_mcp_snapshot_request already checked the endpoint before its try-lock (asserted below).
--   F-M9-1  get_mcp_endpoint_url gets lock_timeout = 2s (it had none), so a locked endpoints table surfaces as
--           55P03 inside the 5 s app timeout instead of a transport abort. The app maps either to 503
--           DATABASE_TIMEOUT; only a genuine NULL (no such endpoint in this org) is a 404.

-- F-M9-2 -----------------------------------------------------------------------------------------------
DO $$
DECLARE f REGPROCEDURE;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'create_mcp_snapshot' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f,
      'DEPRECATED (20261120200001): not executable by any API role. Use create_mcp_snapshot_idempotent.');
  END LOOP;
END $$;

-- F-M9-1 -----------------------------------------------------------------------------------------------
ALTER FUNCTION public.get_mcp_endpoint_url(UUID, UUID) SET lock_timeout = '2s';

-- F-M9-3 (body identical to 20261120000006 except for the ownership check before the advisory lock) --------
CREATE OR REPLACE FUNCTION public.create_mcp_snapshot_idempotent(
  p_organization_id UUID, p_endpoint_id UUID, p_idempotency_key TEXT, p_content_sha256 TEXT, p_tools jsonb,
  p_deadline TIMESTAMPTZ)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $$
DECLARE
  v_deadline TIMESTAMPTZ;
  v_id UUID; v_version INTEGER; v_found BOOLEAN; v_tools INTEGER; t jsonb;
  r RECORD;
BEGIN
  -- Hard cap 3 s after the statement started, whatever the caller sent (5 s app timeout - 2 s margin).
  v_deadline := LEAST(COALESCE(p_deadline, statement_timestamp() + interval '3 seconds'),
                      statement_timestamp() + interval '3 seconds');
  BEGIN
    IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' THEN
      RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
    END IF;
    IF p_tools IS NULL OR jsonb_typeof(p_tools) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_TOOLS' USING ERRCODE = '22023';
    END IF;
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION 'SNAPSHOT_DEADLINE_EXCEEDED' USING ERRCODE = 'PT504',
        DETAIL = 'the request reached the database after its deadline; nothing was written';
    END IF;

    -- F-M9-3: the endpoint must belong to the caller's organization BEFORE the per-(endpoint, key) advisory
    -- lock is touched. Otherwise a caller from another tenant who guesses an endpoint id and key would block
    -- on (and get PT409 for) a request that is running in someone else's tenant, which reveals that it exists.
    -- Plain read, no row lock; the FOR UPDATE below re-checks under the lock.
    IF NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints
                    WHERE id = p_endpoint_id AND organization_id = p_organization_id) THEN
      RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    -- One running request per (endpoint, key). Held until this transaction commits or rolls back.
    BEGIN
      PERFORM pg_advisory_xact_lock(private.mcp_snapshot_request_lock_key(p_endpoint_id, p_idempotency_key));
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'SNAPSHOT_REQUEST_IN_PROGRESS' USING ERRCODE = 'PT409',
        DETAIL = 'a request with this Idempotency-Key is still running';
    END;

    -- Already committed: return the original snapshot (this statement sees any commit that released the lock).
    SELECT q.snapshot_id, q.version INTO r
      FROM public.external_tool_snapshot_requests q
     WHERE q.endpoint_id = p_endpoint_id AND q.organization_id = p_organization_id
       AND q.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT count(*)::int INTO v_tools FROM public.external_tools WHERE snapshot_id = r.snapshot_id;
      RETURN jsonb_build_object('snapshot_id', r.snapshot_id, 'version', r.version, 'tool_count', v_tools,
                                'replayed', true);
    END IF;

    -- Serialize snapshots per endpoint; also proves the endpoint belongs to the org.
    BEGIN
      PERFORM 1 FROM public.external_tool_endpoints
       WHERE id = p_endpoint_id AND organization_id = p_organization_id
       FOR UPDATE;
      v_found := FOUND;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'SNAPSHOT_ENDPOINT_BUSY' USING ERRCODE = 'PT503',
        DETAIL = 'another operation is holding this endpoint; nothing was written';
    END;
    IF NOT v_found THEN
      RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(max(version), 0) + 1 INTO v_version
      FROM public.external_tool_snapshots
     WHERE endpoint_id = p_endpoint_id AND organization_id = p_organization_id;

    INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256)
    VALUES (p_organization_id, p_endpoint_id, v_version, p_content_sha256)
    RETURNING id INTO v_id;
    FOR t IN SELECT * FROM jsonb_array_elements(p_tools) LOOP
      INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class)
      VALUES (p_organization_id, v_id,
              t->>'name', COALESCE(t->>'description',''), COALESCE(t->'input_schema','{}'::jsonb), 'write');
    END LOOP;
    INSERT INTO public.external_tool_snapshot_requests (organization_id, endpoint_id, idempotency_key, snapshot_id, version, created_by)
    VALUES (p_organization_id, p_endpoint_id, p_idempotency_key, v_id, v_version, auth.uid());

    -- Last step: if the body overran the deadline, roll everything back rather than commit after the app gave up.
    IF clock_timestamp() > v_deadline THEN
      RAISE EXCEPTION 'SNAPSHOT_DEADLINE_EXCEEDED' USING ERRCODE = 'PT504',
        DETAIL = 'the write did not finish before its deadline; nothing was written';
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'SNAPSHOT_STORE_BUSY' USING ERRCODE = 'PT503',
      DETAIL = 'the snapshot store is locked; nothing was written';
  END;
  RETURN jsonb_build_object('snapshot_id', v_id, 'version', v_version, 'tool_count', jsonb_array_length(p_tools),
                            'replayed', false);
END;
$$;
ALTER FUNCTION public.create_mcp_snapshot_idempotent(UUID,UUID,TEXT,TEXT,jsonb,TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_mcp_snapshot_idempotent(UUID,UUID,TEXT,TEXT,jsonb,TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_mcp_snapshot_idempotent(UUID,UUID,TEXT,TEXT,jsonb,TIMESTAMPTZ) TO authenticated;

-- Self-check: fail the migration rather than ship a contract the app cannot rely on.
DO $$
DECLARE f REGPROCEDURE; src TEXT; cfg TEXT[]; lt INTERVAL; bad TEXT; own INT; lk INT;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text || ' -> ' || r, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN unnest(ARRAY['public','anon','authenticated','service_role']) r
   WHERE n.nspname = 'public' AND p.proname = 'create_mcp_snapshot'
     AND CASE WHEN r = 'public'
              THEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
              ELSE has_function_privilege(r, p.oid, 'EXECUTE') END;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'legacy create_mcp_snapshot is still executable: %', bad; END IF;

  f := 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure;
  IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'create_mcp_snapshot_idempotent must stay SECURITY DEFINER, executable by authenticated, not anon';
  END IF;
  SELECT prosrc, proconfig INTO src, cfg FROM pg_proc WHERE oid = f;
  own := position('NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints' IN src);
  lk  := position('pg_advisory_xact_lock' IN src);
  IF own = 0 OR lk = 0 OR own > lk THEN
    RAISE EXCEPTION 'create_mcp_snapshot_idempotent must check endpoint ownership before the advisory lock (own=%, lock=%)', own, lk;
  END IF;
  IF position('has_org_role' IN src) = 0 OR position('has_org_role' IN src) > own THEN
    RAISE EXCEPTION 'create_mcp_snapshot_idempotent must check the org role first';
  END IF;
  IF position('interval ''3 seconds''' IN src) = 0 OR position('PT504' IN src) = 0 OR position('PT409' IN src) = 0
     OR position('SNAPSHOT_ENDPOINT_BUSY' IN src) = 0 OR position('FOR UPDATE' IN src) = 0 THEN
    RAISE EXCEPTION 'create_mcp_snapshot_idempotent must keep the 3 s deadline, PT504, PT409 in-progress and the row lock';
  END IF;
  SELECT substring(c FROM 'lock_timeout=(.*)')::interval INTO lt FROM unnest(cfg) c WHERE c LIKE 'lock_timeout=%';
  IF lt IS NULL OR lt > interval '3 seconds' THEN RAISE EXCEPTION 'create_mcp_snapshot_idempotent lock_timeout %', lt; END IF;

  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.get_mcp_snapshot_request(uuid,uuid,text)'::regprocedure;
  own := position('NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints' IN src);
  lk  := position('pg_try_advisory' IN src);
  IF own = 0 OR lk = 0 OR own > lk THEN
    RAISE EXCEPTION 'get_mcp_snapshot_request must check endpoint ownership before its try-lock (own=%, lock=%)', own, lk;
  END IF;

  f := 'public.get_mcp_endpoint_url(uuid,uuid)'::regprocedure;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = f;
  lt := NULL;
  SELECT substring(c FROM 'lock_timeout=(.*)')::interval INTO lt FROM unnest(cfg) c WHERE c LIKE 'lock_timeout=%';
  IF lt IS NULL OR lt > interval '2 seconds' THEN
    RAISE EXCEPTION 'get_mcp_endpoint_url lock_timeout must be <= 2s (app aborts at 5s), got %', lt;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') THEN RAISE EXCEPTION 'get_mcp_endpoint_url must not be anon-executable'; END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private', 'sso') AND p.prosrc ~* 'errcode\s*=\s*''(40001|40P01)''';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'functions raise a PostgREST-retryable SQLSTATE: %', bad; END IF;
END $$;
