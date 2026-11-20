-- deploy/workspace-q9c-preflight.sql
--
-- Read-only gate for the Workspace Q-9c migrations
--   20261120200001_workspace_agent_instructions_confidential
--   20261120200002_workspace_message_citations_confidential
--   20261120200003_workspace_server_authored_messages
-- Procedure and context: docs/workspace/operations.md section 1.
--
--   psql -X -v ON_ERROR_STOP=1 -v phase=before -f deploy/workspace-q9c-preflight.sql   # before applying them
--   psql -X -v ON_ERROR_STOP=1 -v phase=after  -f deploy/workspace-q9c-preflight.sql   # after applying them
--
-- Changes nothing. The session is READ ONLY (proven by a probe write that
-- must be rejected before any check runs). It reads catalog metadata only
-- (roles, functions, privileges, policies): never row data, never secrets.
-- One NOTICE line per check; exits non-zero (exception under ON_ERROR_STOP)
-- if any check fails. A check that cannot be evaluated (missing object) is
-- a failure, never a skip. A partially applied Q-9c set fails in both phases.
\set ON_ERROR_STOP 1
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SET tugpt.q9c_preflight_phase = :'phase';

DO $preflight$
DECLARE
  phase text := current_setting('tugpt.q9c_preflight_phase');
  failures int := 0;
  c record;
BEGIN
  IF phase NOT IN ('before', 'after') THEN
    RAISE EXCEPTION 'phase must be before or after (psql -v phase=...), got "%"', phase;
  END IF;
  BEGIN
    PERFORM set_config('tugpt.q9c_preflight_probe', 'x', true);
    EXECUTE 'CREATE TEMP TABLE q9c_preflight_probe (x int)';
    RAISE EXCEPTION 'session is not read-only; refusing to run';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;  -- expected
  END;

  FOR c IN
    WITH fn(k, sig) AS (VALUES
      ('run',  'public.custom_agent_run_instructions(uuid,uuid,uuid)'),
      ('edit', 'public.custom_agent_instructions(uuid,uuid[])'),
      ('cite', 'public.chat_message_citations(uuid,uuid,uuid[])'),
      ('app',  'public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)')),
    f AS (SELECT k, sig, to_regprocedure(sig) AS oid FROM fn),
    roles_ok AS (SELECT count(*) = 5 AS ok FROM pg_roles WHERE rolname IN ('authenticator', 'sso_control', 'authenticated', 'anon', 'service_role')),
    state AS (SELECT count(oid)::int AS present FROM f),
    exec AS (  -- NULL when the function or a role is missing -> coalesced to a failure below
      SELECT k,
        has_function_privilege('sso_control', oid, 'EXECUTE')   AS sso,
        has_function_privilege('service_role', oid, 'EXECUTE')  AS svc,
        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth,
        has_function_privilege('anon', oid, 'EXECUTE')          AS anon
      FROM f WHERE oid IS NOT NULL AND (SELECT ok FROM roles_ok)),
    col(tbl, col, priv) AS (VALUES
      ('public.custom_agents', 'instructions', 'SELECT'), ('public.custom_agents', 'name', 'SELECT'),
      ('public.chat_messages', 'citations', 'SELECT'), ('public.chat_messages', 'content', 'SELECT'),
      ('public.chat_messages', 'citations', 'INSERT'), ('public.chat_messages', 'capability_key', 'INSERT'),
      ('public.chat_messages', 'knowledge_unavailable', 'INSERT'), ('public.chat_messages', 'content', 'INSERT')),
    cols AS (
      SELECT tbl, col, priv,
        CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(tbl) AND a.attname = col AND NOT a.attisdropped)
             THEN has_column_privilege('authenticated', tbl, col, priv) END AS granted
      FROM col),
    pol AS (SELECT pg_get_expr(p.polwithcheck, p.polrelid) AS chk FROM pg_policy p
            WHERE p.polrelid = to_regclass('public.chat_messages') AND p.polname = 'messages_owner_append'),
    checks(n, phases, name, ok, detail) AS (
      SELECT 1, 'both', 'roles authenticator, sso_control, authenticated, anon, service_role exist', (SELECT ok FROM roles_ok), ''
      UNION ALL SELECT 2, 'both', 'authenticator is a member of sso_control (PostgREST can SET ROLE sso_control)',
        coalesce((SELECT ok FROM roles_ok) AND pg_has_role('authenticator', 'sso_control', 'MEMBER'), false),
        'also required today by sso.load_session; without it every login fails'
      UNION ALL SELECT 3, 'both', 'sso.pre_request() exists', to_regprocedure('sso.pre_request()') IS NOT NULL, ''
      UNION ALL SELECT 4, 'both', 'sso.load_session exists', EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'sso' AND p.proname = 'load_session'), ''
      UNION ALL SELECT 5, 'both', 'Q-9c functions are all present or all absent (no partial apply)', (SELECT present IN (0, 4) FROM state), (SELECT present || '/4 present' FROM state)
      UNION ALL SELECT 10, 'before', 'Q-9c not applied yet', (SELECT present = 0 FROM state), (SELECT CASE present WHEN 4 THEN 'already applied: run phase=after' ELSE '' END FROM state)
      UNION ALL SELECT 11, 'before', 'policy messages_owner_append exists (200003 replaces it)', EXISTS (SELECT 1 FROM pol), ''
      UNION ALL SELECT 12, 'before', 'columns custom_agents.instructions and chat_messages.citations exist',
        (SELECT count(*) = 2 FROM cols WHERE (tbl, col, priv) IN (('public.custom_agents', 'instructions', 'SELECT'), ('public.chat_messages', 'citations', 'SELECT')) AND granted IS NOT NULL), ''
      UNION ALL SELECT 20, 'after', 'all four Q-9c functions exist', (SELECT present = 4 FROM state), (SELECT present || '/4' FROM state)
      UNION ALL SELECT 21, 'after', 'server-only functions: EXECUTE for sso_control and service_role only',
        coalesce((SELECT count(*) = 2 AND bool_and(sso AND svc AND NOT auth AND NOT anon) FROM exec WHERE k IN ('run', 'app')), false), 'custom_agent_run_instructions, append_chat_message_server'
      UNION ALL SELECT 22, 'after', 'user functions: EXECUTE for authenticated, not anon',
        coalesce((SELECT count(*) = 2 AND bool_and(auth AND NOT anon) FROM exec WHERE k IN ('edit', 'cite')), false), 'custom_agent_instructions, chat_message_citations'
      UNION ALL SELECT 23, 'after', 'authenticated cannot SELECT custom_agents.instructions or chat_messages.citations',
        coalesce((SELECT count(*) = 2 AND NOT bool_or(granted) FROM cols WHERE priv = 'SELECT' AND col IN ('instructions', 'citations')), false), ''
      UNION ALL SELECT 24, 'after', 'authenticated can still SELECT custom_agents.name and chat_messages.content',
        coalesce((SELECT count(*) = 2 AND bool_and(granted) FROM cols WHERE priv = 'SELECT' AND col IN ('name', 'content')), false), ''
      UNION ALL SELECT 25, 'after', 'authenticated cannot INSERT chat_messages.citations, capability_key, knowledge_unavailable',
        coalesce((SELECT count(*) = 3 AND NOT bool_or(granted) FROM cols WHERE priv = 'INSERT' AND col <> 'content'), false), ''
      UNION ALL SELECT 26, 'after', 'authenticated can still INSERT chat_messages.content',
        coalesce((SELECT bool_and(granted) FROM cols WHERE priv = 'INSERT' AND col = 'content'), false), ''
      UNION ALL SELECT 27, 'after', 'policy messages_owner_append only admits role = user',
        coalesce((SELECT chk LIKE '%(role = ''user''::text)%' FROM pol), false), '')
    SELECT * FROM checks WHERE phases IN ('both', phase) ORDER BY n
  LOOP
    IF c.ok THEN RAISE NOTICE 'ok   %', c.name;
    ELSE failures := failures + 1; RAISE NOTICE 'FAIL % %', c.name, CASE WHEN c.detail <> '' THEN '(' || c.detail || ')' ELSE '' END;
    END IF;
  END LOOP;
  IF failures > 0 THEN
    RAISE EXCEPTION 'workspace Q-9c preflight (%): % check(s) failed', phase, failures;
  END IF;
  RAISE NOTICE 'workspace Q-9c preflight (%): all checks passed', phase;
END
$preflight$;
