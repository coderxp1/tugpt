-- Agent 2 (MCP reliability): a customer MCP tool that runs and answers `isError: true` is audited as TOOL_ERROR,
-- distinct from PROVIDER_UNAVAILABLE (endpoint unreachable). Both the mcp_tool_calls CHECK constraint and the
-- record_mcp_tool_call allow-list must accept it, every existing outcome must stay accepted, unknown outcomes
-- must stay rejected, and the RPC's privileges must not widen. Real Postgres.
BEGIN;
SELECT plan(9);

INSERT INTO auth.users (id, email) VALUES ('a6000000-0000-4000-8000-0000000000a1', 'a6-owner@example.test');
INSERT INTO public.profiles (id, email) VALUES ('a6000000-0000-4000-8000-0000000000a1', 'a6-owner@example.test') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES ('a6000000-0000-4000-8000-00000000000a', 'A6 Org', 'a6-org');
INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000a1', 'owner') ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status)
  VALUES ('a6000000-0000-4000-8000-0000000e000a', 'a6000000-0000-4000-8000-00000000000a', 'mcp', 'https://a6.example.test/mcp', 'A6', 'active');
-- Tools are attached while the snapshot is unreviewed (approved snapshots are immutable), then it is approved.
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256)
  VALUES ('a6000000-0000-4000-8000-00000000500a', 'a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000e000a', 1, repeat('6',64));
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class)
  VALUES ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-00000000500a', 'get-sum', 'sum', '{"type":"object"}', 'write');
UPDATE public.external_tool_snapshots SET approved_by = 'a6000000-0000-4000-8000-0000000000a1', approved_at = now()
 WHERE id = 'a6000000-0000-4000-8000-00000000500a';

CREATE FUNCTION pg_temp.rec(o text) RETURNS void LANGUAGE sql AS $f$
  SELECT public.record_mcp_tool_call('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000e000a',
    'a6000000-0000-4000-8000-0000000000a1', 'external.get-sum', o, o, 5, repeat('a',64)) $f$;
GRANT EXECUTE ON FUNCTION pg_temp.rec(text) TO service_role;

SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT pg_temp.rec('TOOL_ERROR')$$, 'O1: RPC accepts TOOL_ERROR');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.mcp_tool_calls WHERE endpoint_id = 'a6000000-0000-4000-8000-0000000e000a' AND outcome = 'TOOL_ERROR'), 1,
  'O2: TOOL_ERROR row persisted');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT pg_temp.rec('BOGUS')$$, '22023', 'INVALID_OUTCOME', 'O3: RPC still rejects unknown outcomes');
SELECT lives_ok($$SELECT pg_temp.rec(o) FROM unnest(ARRAY['ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH',
  'CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE',
  'OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL']) AS o$$, 'O4: every pre-existing outcome still accepted');
RESET ROLE;
SELECT lives_ok($$INSERT INTO public.mcp_tool_calls (organization_id, actor_user_id, endpoint_id, capability, outcome, duration_ms, arguments_sha256)
  VALUES ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000a1', 'a6000000-0000-4000-8000-0000000e000a',
          'external.get-sum', 'TOOL_ERROR', 1, repeat('b',64))$$, 'O5: CHECK constraint accepts TOOL_ERROR');
SELECT throws_ok($$INSERT INTO public.mcp_tool_calls (organization_id, actor_user_id, endpoint_id, capability, outcome, duration_ms, arguments_sha256)
  VALUES ('a6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-0000000000a1', 'a6000000-0000-4000-8000-0000000e000a',
          'external.get-sum', 'BOGUS', 1, repeat('b',64))$$, '23514', NULL, 'O6: CHECK constraint still rejects unknown outcomes');
SELECT ok(NOT has_function_privilege('anon', 'public.record_mcp_tool_call(uuid,uuid,uuid,text,text,text,integer,text)', 'EXECUTE'), 'O7: anon cannot execute');
SELECT ok(NOT has_function_privilege('authenticated', 'public.record_mcp_tool_call(uuid,uuid,uuid,text,text,text,integer,text)', 'EXECUTE'), 'O8: authenticated cannot execute');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
  WHERE oid = 'public.record_mcp_tool_call(uuid,uuid,uuid,text,text,text,integer,text)'::regprocedure), 'O9: SECURITY DEFINER, search_path pinned');

SELECT * FROM finish();
ROLLBACK;
