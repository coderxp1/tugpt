-- Agent 2 (Agent 1 M4 acceptance of 16a1594): idempotent MCP snapshot creation with an observable outcome.
--
-- Defect: after an app-side timeout the route answered 503 while PostgreSQL could still commit the snapshot
-- (a 6 s write committed after the 5 s app cutoff), and a client retry then created a second snapshot from
-- the same intent. Nothing let the client find out what had happened.
--
-- Fix (forward-only; 20261120000002/04/05 are not edited):
--   * external_tool_snapshot_requests: one row per committed request, UNIQUE (endpoint_id, idempotency_key),
--     written in the SAME transaction as the snapshot and its tools. A row exists iff the request committed.
--   * create_mcp_snapshot_idempotent(org, endpoint, key, sha256, tools, deadline):
--       - per-key transaction advisory lock (private.mcp_snapshot_request_lock_key). It is held exactly while
--         the request's transaction runs, so "still running" is a fact, not a guess. Not available within
--         lock_timeout -> PT409 SNAPSHOT_REQUEST_IN_PROGRESS.
--       - key already committed -> the ORIGINAL snapshot id/version, replayed=true, nothing written.
--       - otherwise the endpoint row lock (PT503 SNAPSHOT_ENDPOINT_BUSY if not available within lock_timeout),
--         version = latest + 1 assigned here (callers no longer pass a version, so requests with different
--         keys never conflict; they are serialized and numbered), snapshot + tools + request row.
--       - deadline: the write may only commit if the function body finished before
--         LEAST(p_deadline, statement start + 3 s). Checked at entry and as the LAST step before returning, so a
--         body that overran (slow trigger, slow I/O) rolls back instead of committing after the app gave up.
--         -> PT504 SNAPSHOT_DEADLINE_EXCEEDED (nothing written).
--       - any other lock not available within lock_timeout -> PT503 SNAPSHOT_STORE_BUSY.
--   * get_mcp_snapshot_request(org, endpoint, key): committed | in_progress | not_found.
-- PTxyz codes are answered by PostgREST as HTTP xyz and never retried; no 40001/40P01.
-- create_mcp_snapshot (keyless) is left unchanged for code still deployed; the app no longer calls it.

CREATE TABLE public.external_tool_snapshot_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  snapshot_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT external_tool_snapshot_requests_endpoint_key UNIQUE (endpoint_id, idempotency_key),
  CONSTRAINT external_tool_snapshot_requests_snapshot UNIQUE (snapshot_id),
  FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES public.external_tool_endpoints (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, organization_id)
    REFERENCES public.external_tool_snapshots (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX external_tool_snapshot_requests_org ON public.external_tool_snapshot_requests (organization_id);
ALTER TABLE public.external_tool_snapshot_requests ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: reachable only through the two SECURITY DEFINER functions below.
REVOKE ALL ON public.external_tool_snapshot_requests FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.mcp_snapshot_request_lock_key(p_endpoint_id UUID, p_idempotency_key TEXT)
RETURNS BIGINT LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
AS $$ SELECT hashtextextended('external_tool_snapshot_request:' || p_endpoint_id::text || ':' || p_idempotency_key, 0) $$;
ALTER FUNCTION private.mcp_snapshot_request_lock_key(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mcp_snapshot_request_lock_key(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_mcp_snapshot_idempotent(
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

CREATE FUNCTION public.get_mcp_snapshot_request(p_organization_id UUID, p_endpoint_id UUID, p_idempotency_key TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $$
DECLARE v_free BOOLEAN; r RECORD; v_tools INTEGER;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints WHERE id = p_endpoint_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- Shared try-lock first: if it is free, any earlier holder has finished, and the read below sees its commit.
  v_free := pg_try_advisory_xact_lock_shared(private.mcp_snapshot_request_lock_key(p_endpoint_id, p_idempotency_key));
  BEGIN
    SELECT q.snapshot_id, q.version INTO r
      FROM public.external_tool_snapshot_requests q
     WHERE q.endpoint_id = p_endpoint_id AND q.organization_id = p_organization_id
       AND q.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT count(*)::int INTO v_tools FROM public.external_tools WHERE snapshot_id = r.snapshot_id;
      RETURN jsonb_build_object('state', 'committed', 'snapshot_id', r.snapshot_id, 'version', r.version, 'tool_count', v_tools);
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    -- e.g. DDL holding external_tools: a documented, retryable 503, never a generic error (route 500).
    RAISE EXCEPTION 'SNAPSHOT_STORE_BUSY' USING ERRCODE = 'PT503',
      DETAIL = 'the snapshot store is locked; retry the status check';
  END;
  RETURN jsonb_build_object('state', CASE WHEN v_free THEN 'not_found' ELSE 'in_progress' END);
END;
$$;
ALTER FUNCTION public.get_mcp_snapshot_request(UUID,UUID,TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_mcp_snapshot_request(UUID,UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mcp_snapshot_request(UUID,UUID,TEXT) TO authenticated;

-- Self-check: fail the migration rather than ship a budget or contract the app cannot rely on.
DO $$
DECLARE f REGPROCEDURE; src TEXT; cfg TEXT[]; lt INTERVAL; bad TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure,
                           'public.get_mcp_snapshot_request(uuid,uuid,text)'::regprocedure] LOOP
    SELECT prosrc, proconfig INTO src, cfg FROM pg_proc WHERE oid = f;
    SELECT substring(c FROM 'lock_timeout=(.*)')::interval INTO lt FROM unnest(cfg) c WHERE c LIKE 'lock_timeout=%';
    IF lt IS NULL OR lt > interval '3 seconds' THEN
      RAISE EXCEPTION '% lock_timeout must be <= 3s (app aborts PostgREST requests at 5s), got %', f, lt;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN RAISE EXCEPTION '% must be SECURITY DEFINER', f; END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '% grants are wrong', f;
    END IF;
    IF position('has_org_role' IN src) = 0 OR position('mcp_snapshot_request_lock_key' IN src) = 0 THEN
      RAISE EXCEPTION '% must check the org role and use the shared request lock key', f;
    END IF;
  END LOOP;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure;
  IF position('interval ''3 seconds''' IN src) = 0 OR position('PT504' IN src) = 0 OR position('PT409' IN src) = 0
     OR position('SNAPSHOT_ENDPOINT_BUSY' IN src) = 0 OR position('FOR UPDATE' IN src) = 0 THEN
    RAISE EXCEPTION 'create_mcp_snapshot_idempotent must keep the 3 s deadline, PT504, PT409 in-progress and the row lock';
  END IF;
  IF has_table_privilege('authenticated', 'public.external_tool_snapshot_requests', 'SELECT')
     OR has_table_privilege('anon', 'public.external_tool_snapshot_requests', 'SELECT') THEN
    RAISE EXCEPTION 'external_tool_snapshot_requests must not be directly readable';
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private', 'sso') AND p.prosrc ~* 'errcode\s*=\s*''(40001|40P01)''';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'functions raise a PostgREST-retryable SQLSTATE: %', bad; END IF;
END $$;
