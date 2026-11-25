-- mcp_approval_requests.test.sql
-- A5 (ADR-021 R6): a member files an approval request for one exact blocked
-- write-class call; owners/admins list and decide; approval records the
-- single-use tool_approvals row FOR THE REQUESTER via record_tool_approval.
BEGIN;
SELECT plan(16);

INSERT INTO auth.users (id, email) VALUES
  ('c5000000-0000-4000-8000-0000000000a1', 'a5-owner@example.test'),
  ('c5000000-0000-4000-8000-0000000000a2', 'a5-member@example.test'),
  ('c5000000-0000-4000-8000-0000000000a3', 'a5-outsider@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('c5000000-0000-4000-8000-0000000000a1', 'a5-owner@example.test'),
  ('c5000000-0000-4000-8000-0000000000a2', 'a5-member@example.test'),
  ('c5000000-0000-4000-8000-0000000000a3', 'a5-outsider@example.test') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('c5000000-0000-4000-8000-00000000000a', 'A5 Org', 'a5-org'),
  ('c5000000-0000-4000-8000-00000000000b', 'A5 Other', 'a5-other');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000000a1', 'owner'),
  ('c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000000a2', 'member'),
  ('c5000000-0000-4000-8000-00000000000b', 'c5000000-0000-4000-8000-0000000000a3', 'owner') ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status, auth_connection_id) VALUES
  ('c5000000-0000-4000-8000-0000000e0001', 'c5000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/a5', 'A5', 'active', NULL);
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256, approved_by, approved_at) VALUES
  ('c5000000-0000-4000-8000-00000005e001', 'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001', 1, repeat('f', 64), 'c5000000-0000-4000-8000-0000000000a1', now());
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
  ('c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-00000005e001', 'send_report', 'A5 write', '{"type":"object"}', 'write'),
  ('c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-00000005e001', 'search_docs', 'A5 read', '{"type":"object"}', 'read');

-- ---- ACLs ------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.mcp_approval_requests', 'SELECT'), 'T1: authenticated has no direct table access');
SELECT ok(has_table_privilege('service_role', 'public.mcp_approval_requests', 'SELECT')
      AND has_table_privilege('service_role', 'public.mcp_approval_requests', 'UPDATE'), 'T2: service_role has table access');

-- ---- create (as the member) -------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT set_config('a5.req_a', (SELECT id::text FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.send_report', repeat('a', 64), 'c5000000-0000-4000-8000-000000007701')), true);
SELECT ok(current_setting('a5.req_a') IS NOT NULL, 'C1: a member files a request for a blocked write call');
SELECT is((SELECT id::text FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.send_report', repeat('a', 64), 'c5000000-0000-4000-8000-000000007701')),
  current_setting('a5.req_a'), 'C2: re-filing the same call returns the same pending request');
SELECT throws_ok($$SELECT * FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.search_docs', repeat('a', 64), 'c5000000-0000-4000-8000-000000007701')$$,
  '22023', 'INVALID_CAPABILITY', 'C3: a read-class call never needs a request');
SELECT throws_ok($$SELECT * FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.send_report', 'not-a-hash', 'c5000000-0000-4000-8000-000000007701')$$,
  '22023', 'INVALID_ARGUMENTS_HASH', 'C4: a malformed arguments hash is refused');
SELECT set_config('a5.req_b', (SELECT id::text FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.send_report', repeat('b', 64), 'c5000000-0000-4000-8000-000000007701')), true);
SELECT ok(current_setting('a5.req_b') <> current_setting('a5.req_a'), 'C6: a changed call (different hash) is a new request');

-- outsider (owner of another org, not a member here)
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
SELECT throws_ok($$SELECT * FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.send_report', repeat('d', 64), 'c5000000-0000-4000-8000-000000007701')$$,
  '42501', 'FORBIDDEN', 'C5: a non-member cannot file requests');

-- owner files one too (for the list-scoping checks)
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT set_config('a5.req_c', (SELECT id::text FROM public.request_mcp_approval(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e0001',
  'external.send_report', repeat('c', 64), 'c5000000-0000-4000-8000-000000007701')), true);

-- ---- list scoping ------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.list_mcp_approval_requests('c5000000-0000-4000-8000-00000000000a')), 2,
  'L1: a member lists only their own requests');
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.list_mcp_approval_requests('c5000000-0000-4000-8000-00000000000a')), 3,
  'L2: an owner lists the whole org queue');

-- ---- decide -------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok($$SELECT * FROM public.decide_mcp_approval_request(
  'c5000000-0000-4000-8000-00000000000a', current_setting('a5.req_a')::uuid, 'approved', 900)$$,
  '42501', 'FORBIDDEN', 'D1: a member cannot decide requests');
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is((SELECT status FROM public.decide_mcp_approval_request(
  'c5000000-0000-4000-8000-00000000000a', current_setting('a5.req_b')::uuid, 'denied', 900)),
  'denied', 'D2: an owner denies a request');
SELECT throws_ok($$SELECT * FROM public.decide_mcp_approval_request(
  'c5000000-0000-4000-8000-00000000000a', current_setting('a5.req_b')::uuid, 'approved', 900)$$,
  'PT409', 'ALREADY_DECIDED', 'D3: a decided request is final');
SELECT set_config('a5.dec_a', (SELECT approval_id::text FROM public.decide_mcp_approval_request(
  'c5000000-0000-4000-8000-00000000000a', current_setting('a5.req_a')::uuid, 'approved', 900)), true);
RESET ROLE;
SELECT ok(current_setting('a5.dec_a') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.tool_approvals ta
              WHERE ta.id = current_setting('a5.dec_a')::uuid
                AND ta.requested_by = 'c5000000-0000-4000-8000-0000000000a2'
                AND ta.approved_by = 'c5000000-0000-4000-8000-0000000000a1'),
  'D4: approval records the single-use approval FOR THE REQUESTER');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"c5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT * FROM public.decide_mcp_approval_request(
  'c5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-0000000e9999', 'approved', 900)$$,
  'P0002', 'REQUEST_NOT_FOUND', 'D5: an unknown request id is a typed not-found');
SELECT throws_ok($$SELECT * FROM public.decide_mcp_approval_request(
  'c5000000-0000-4000-8000-00000000000a', current_setting('a5.req_c')::uuid, 'maybe', 900)$$,
  '22023', 'INVALID_DECISION', 'D6: an unknown decision is refused');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
