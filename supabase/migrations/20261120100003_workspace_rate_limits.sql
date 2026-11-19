-- Workspace rate limits (Agent 4): fixed-window counters per
-- (action, organization, user), enforced by the API before expensive work
-- (uploads, search, agent runs, reindex).
--
-- Limits are server policy, not request input: the caller names only the
-- action; the window and maximum come from private.workspace_rate_limit_policies
-- (tunable by operators with SQL, not reachable through PostgREST).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE private.workspace_rate_limit_policies (
  action TEXT PRIMARY KEY CHECK (action ~ '^[a-z]+\.[a-z_]+$'),
  max_count INTEGER NOT NULL CHECK (max_count BETWEEN 1 AND 100000),
  window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400)
);
INSERT INTO private.workspace_rate_limit_policies (action, max_count, window_seconds) VALUES
  ('file.upload', 60, 3600),
  ('library.search', 120, 60),
  ('document.reindex', 60, 3600),
  ('agent.run', 30, 60),
  ('agent.write', 60, 3600);
REVOKE ALL ON private.workspace_rate_limit_policies FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.workspace_rate_limits (
  bucket TEXT PRIMARY KEY CHECK (char_length(bucket) <= 200),
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);
CREATE INDEX workspace_rate_limits_window ON private.workspace_rate_limits (window_start);
REVOKE ALL ON private.workspace_rate_limits FROM PUBLIC, anon, authenticated, service_role;

-- Counts one attempt for the calling user and reports whether it is allowed.
-- Unknown actions and non-members are rejected; the counter only advances for
-- real members, so outsiders cannot exhaust another tenant's budget.
CREATE OR REPLACE FUNCTION public.consume_workspace_rate_limit(p_organization_id UUID, p_action TEXT)
RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, retry_after_seconds INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_uid UUID := auth.uid();
  p private.workspace_rate_limit_policies%ROWTYPE;
  r private.workspace_rate_limits%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT private.is_org_member(p_organization_id, v_uid) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM private.workspace_rate_limit_policies x WHERE x.action = p_action;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ACTION' USING ERRCODE = '22023'; END IF;
  INSERT INTO private.workspace_rate_limits AS w (bucket, window_start, count)
  VALUES (p.action || ':' || p_organization_id || ':' || v_uid, now(), 1)
  ON CONFLICT (bucket) DO UPDATE SET
    window_start = CASE WHEN w.window_start + make_interval(secs => p.window_seconds) <= now() THEN now() ELSE w.window_start END,
    count = CASE WHEN w.window_start + make_interval(secs => p.window_seconds) <= now() THEN 1 ELSE LEAST(w.count + 1, 1000000) END
  RETURNING w.* INTO r;
  allowed := r.count <= p.max_count;
  remaining := GREATEST(p.max_count - r.count, 0);
  retry_after_seconds := CASE WHEN allowed THEN 0
    ELSE GREATEST(1, CEIL(EXTRACT(EPOCH FROM (r.window_start + make_interval(secs => p.window_seconds) - now())))::INTEGER) END;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.consume_workspace_rate_limit(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_workspace_rate_limit(UUID,TEXT) TO authenticated;

-- Maintenance: drop counters whose window ended more than a day ago.
CREATE OR REPLACE FUNCTION public.prune_workspace_rate_limits()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_n INTEGER;
BEGIN
  DELETE FROM private.workspace_rate_limits w WHERE w.window_start < now() - interval '2 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.prune_workspace_rate_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_workspace_rate_limits() TO service_role;

COMMIT;
