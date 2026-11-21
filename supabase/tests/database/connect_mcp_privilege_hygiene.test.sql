-- connect_mcp_privilege_hygiene.test.sql
-- Regression for 20261120000001: approval and MCP audit tables are read-only
-- to every API role, and the trusted SECURITY DEFINER paths still work.
-- Real Postgres, behavioural SET ROLE assertions plus catalogue checks.
BEGIN;
SELECT plan(28);

-- ---- fixture (two tenants) -----------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('a2000000-0000-4000-8000-0000000000a1', 'a2-owner-a@example.test'),
  ('a2000000-0000-4000-8000-0000000000b1', 'a2-owner-b@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('a2000000-0000-4000-8000-0000000000a1', 'a2-owner-a@example.test'),
  ('a2000000-0000-4000-8000-0000000000b1', 'a2-owner-b@example.test')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('a2000000-0000-4000-8000-00000000000a', 'A2 Org A', 'a2-org-a'),
  ('a2000000-0000-4000-8000-00000000000b', 'A2 Org B', 'a2-org-b');
INSERT INTO public.organization_members (organization_id, user_id) VALUES
  ('a2000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-0000000000a1'),
  ('a2000000-0000-4000-8000-00000000000b', 'a2000000-0000-4000-8000-0000000000b1')
  ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('a2000000-0000-4000-8000-0000000e0001', 'a2000000-0000-4000-8000-00000000000a', 'mcp',
   'https://mcp.example.test/a', 'A2 EP', 'active');
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256) VALUES
  ('a2000000-0000-4000-8000-00000005e001', 'a2000000-0000-4000-8000-00000000000a',
   'a2000000-0000-4000-8000-0000000e0001', 1, repeat('c', 64));
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
  ('a2000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-00000005e001',
   'create_ticket', 'A2 test tool', '{}'::jsonb, 'write');
UPDATE public.external_tool_snapshots
   SET approved_by = 'a2000000-0000-4000-8000-0000000000a1', approved_at = now()
 WHERE id = 'a2000000-0000-4000-8000-00000005e001';
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
  ('a2000000-0000-4000-8000-00000000c001', 'a2000000-0000-4000-8000-00000000000a',
   'a2000000-0000-4000-8000-0000000000a1', 'A2 thread', 'tugpt-scout');
INSERT INTO public.tool_approvals (id, organization_id, connection_id, capability, arguments_sha256,
                                   approved_by, expires_at, requested_by, thread_id) VALUES
  ('a2000000-0000-4000-8000-0000000a9001', 'a2000000-0000-4000-8000-00000000000a',
   'a2000000-0000-4000-8000-0000000e0001', 'external.create_ticket', repeat('a', 64),
   'a2000000-0000-4000-8000-0000000000a1', now() + interval '10 minutes',
   'a2000000-0000-4000-8000-0000000000a1', 'a2000000-0000-4000-8000-00000000c001');

-- ---- catalogue ------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name IN ('tool_approvals','mcp_tool_calls')
      AND grantee='anon'),
  0, 'C1: anon holds no privilege on tool_approvals / mcp_tool_calls');
SELECT is(
  (SELECT string_agg(table_name||':'||privilege_type, ',' ORDER BY table_name, privilege_type)
     FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name IN ('tool_approvals','mcp_tool_calls')
      AND grantee='authenticated'),
  'mcp_tool_calls:SELECT,tool_approvals:SELECT',
  'C2: authenticated holds exactly SELECT on both tables');
SELECT is(
  (SELECT string_agg(table_name||':'||privilege_type, ',' ORDER BY table_name, privilege_type)
     FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name IN ('tool_approvals','mcp_tool_calls')
      AND grantee='service_role'),
  'mcp_tool_calls:SELECT,tool_approvals:SELECT',
  'C3: service_role holds exactly SELECT (writes only via definer RPCs)');
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name IN ('tool_approvals','mcp_tool_calls')
      AND grantee='PUBLIC'),
  0, 'C4: PUBLIC holds nothing');
SELECT ok(
  (SELECT bool_and(p.prosecdef) FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN ('record_tool_approval','claim_tool_approval','revoke_tool_approval',
                        'is_tool_approved','record_mcp_tool_call')),
  'C5: every writer RPC is SECURITY DEFINER');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace
      AND p.proname IN ('record_tool_approval','claim_tool_approval','revoke_tool_approval',
                        'is_tool_approved','record_mcp_tool_call')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  0, 'C6: anon cannot execute any approval/audit RPC');
SELECT ok(
  has_function_privilege('sso_control',
    'public.record_mcp_tool_call(uuid,uuid,uuid,text,text,text,integer,text)', 'EXECUTE'),
  'C7: trusted audit identity sso_control keeps EXECUTE on record_mcp_tool_call');

-- ---- behaviour: authenticated -------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT throws_ok($$TRUNCATE public.tool_approvals$$, '42501', NULL, 'B1: authenticated TRUNCATE tool_approvals refused');
SELECT throws_ok($$TRUNCATE public.mcp_tool_calls$$, '42501', NULL, 'B2: authenticated TRUNCATE mcp_tool_calls refused');
SELECT throws_ok($$DELETE FROM public.tool_approvals$$, '42501', NULL, 'B3: authenticated DELETE tool_approvals refused');
SELECT throws_ok($$DELETE FROM public.mcp_tool_calls$$, '42501', NULL, 'B4: authenticated DELETE mcp_tool_calls refused (audit undeletable)');
SELECT throws_ok($$UPDATE public.tool_approvals SET used_at = NULL$$, '42501', NULL, 'B5: authenticated UPDATE tool_approvals refused (cannot un-consume)');
SELECT throws_ok($$UPDATE public.mcp_tool_calls SET outcome = outcome$$, '42501', NULL, 'B6: authenticated UPDATE mcp_tool_calls refused (audit unforgeable)');
SELECT throws_ok($$INSERT INTO public.mcp_tool_calls DEFAULT VALUES$$, '42501', NULL, 'B7: authenticated INSERT mcp_tool_calls refused (audit unforgeable)');
SELECT throws_ok($$INSERT INTO public.tool_approvals DEFAULT VALUES$$, '42501', NULL, 'B8: authenticated INSERT tool_approvals refused (cannot self-approve)');
SELECT is((SELECT count(*)::int FROM public.tool_approvals
            WHERE id='a2000000-0000-4000-8000-0000000a9001'),
  1, 'B9: authenticated member SELECT sees own-tenant approval (RLS read path intact)');
SELECT lives_ok($$SELECT count(*) FROM public.mcp_tool_calls$$, 'B10: authenticated SELECT mcp_tool_calls allowed');

-- Since 20261120000010 the unaudited claim is closed to API roles; the
-- audited claim is the trusted definer path that must still consume.
SELECT throws_ok($$SELECT public.claim_tool_approval('a2000000-0000-4000-8000-00000000000a',
    'a2000000-0000-4000-8000-0000000e0001', 'external.create_ticket', repeat('a', 64),
    'a2000000-0000-4000-8000-00000000c001')$$,
  '42501', NULL, 'P0: authenticated can no longer execute the unaudited claim_tool_approval');
SELECT is(
  (SELECT claimed::text||':'||reason FROM public.claim_tool_approval_audited('a2000000-0000-4000-8000-00000000000a',
    'a2000000-0000-4000-8000-0000000e0001', 'external.create_ticket', repeat('a', 64),
    'a2000000-0000-4000-8000-00000000c001', 'approved_call')),
  'true:OK', 'P1: claim_tool_approval_audited (SECURITY DEFINER) still consumes an approval');
SELECT is(
  (SELECT claimed::text||':'||reason FROM public.claim_tool_approval_audited('a2000000-0000-4000-8000-00000000000a',
    'a2000000-0000-4000-8000-0000000e0001', 'external.create_ticket', repeat('a', 64),
    'a2000000-0000-4000-8000-00000000c001', 'approved_call')),
  'false:ALREADY_USED', 'P2: single-use preserved — second claim refused');
RESET ROLE;

SELECT isnt((SELECT used_at FROM public.tool_approvals WHERE id='a2000000-0000-4000-8000-0000000a9001'),
  NULL, 'P3: used_at was written by the definer path');

-- tenant isolation: org B owner sees nothing of org A and cannot claim
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.tool_approvals
            WHERE organization_id='a2000000-0000-4000-8000-00000000000a'),
  0, 'T1: foreign-tenant member sees no org A approvals');
SELECT is(
  (SELECT claimed::text||':'||reason FROM public.claim_tool_approval_audited('a2000000-0000-4000-8000-00000000000a',
    'a2000000-0000-4000-8000-0000000e0001', 'external.create_ticket', repeat('a', 64),
    'a2000000-0000-4000-8000-00000000c001', 'approved_call')),
  'false:FORBIDDEN', 'T2: foreign-tenant claim refused');
RESET ROLE;

-- ---- behaviour: anon / service_role --------------------------------------
SET LOCAL ROLE anon;
SELECT throws_ok($$TRUNCATE public.tool_approvals$$, '42501', NULL, 'B11: anon TRUNCATE refused');
SELECT throws_ok($$SELECT 1 FROM public.mcp_tool_calls$$, '42501', NULL, 'B12: anon SELECT refused');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT throws_ok($$TRUNCATE public.mcp_tool_calls$$, '42501', NULL, 'B13: service_role TRUNCATE audit refused');
SELECT throws_ok($$DELETE FROM public.mcp_tool_calls$$, '42501', NULL, 'B14: service_role DELETE audit refused');
SELECT lives_ok($$SELECT count(*) FROM public.mcp_tool_calls$$, 'B15: service_role SELECT audit allowed');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
