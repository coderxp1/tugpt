-- workspace_approval_requests.test.sql — 20261119100002: request lifecycle
-- (pending/approved/rejected/cancelled/expired/used/revoked), delegation to
-- Agent 2's record/revoke_tool_approval, history and cross-tenant rejection.
BEGIN;
SELECT plan(40);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f5111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_appr_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f5222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_appr_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f5333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_appr_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('f5a00000-0000-4000-8000-00000000000a','Appr A','ws-appr-a'),
 ('f5b00000-0000-4000-8000-00000000000b','Appr B','ws-appr-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','owner'),
 ('f5a00000-0000-4000-8000-00000000000a','f5222222-2222-4222-8222-222222222222','agent'),
 ('f5b00000-0000-4000-8000-00000000000b','f5333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('f5700000-0000-4000-8000-0000000000a2','f5a00000-0000-4000-8000-00000000000a','f5222222-2222-4222-8222-222222222222','Invoices','tugpt-scout'),
 ('f5700000-0000-4000-8000-0000000000a1','f5a00000-0000-4000-8000-00000000000a','f5111111-1111-4111-8111-111111111111','Owner','tugpt-scout'),
 ('f5700000-0000-4000-8000-0000000000b1','f5b00000-0000-4000-8000-00000000000b','f5333333-3333-4333-8333-333333333333','B','tugpt-scout');
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
 ('f5e00000-0000-4000-8000-00000000000a','f5a00000-0000-4000-8000-00000000000a','mcp','https://mcp.example.com/a','Billing MCP','active'),
 ('f5e00000-0000-4000-8000-00000000000b','f5b00000-0000-4000-8000-00000000000b','mcp','https://mcp.example.com/b','B MCP','active');
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256) VALUES
 ('f5500000-0000-4000-8000-00000000000a','f5a00000-0000-4000-8000-00000000000a','f5e00000-0000-4000-8000-00000000000a',1,repeat('a',64)),
 ('f5500000-0000-4000-8000-00000000000b','f5b00000-0000-4000-8000-00000000000b','f5e00000-0000-4000-8000-00000000000b',1,repeat('b',64));
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
 ('f5a00000-0000-4000-8000-00000000000a','f5500000-0000-4000-8000-00000000000a','send_invoice','Send','{}','write'),
 ('f5a00000-0000-4000-8000-00000000000a','f5500000-0000-4000-8000-00000000000a','list_invoices','List','{}','read'),
 ('f5b00000-0000-4000-8000-00000000000b','f5500000-0000-4000-8000-00000000000b','send_invoice','Send','{}','write');
-- approve snapshots only after their tools exist (approved snapshots are immutable)
UPDATE public.external_tool_snapshots SET approved_by='f5111111-1111-4111-8111-111111111111', approved_at=now() WHERE id='f5500000-0000-4000-8000-00000000000a';
UPDATE public.external_tool_snapshots SET approved_by='f5333333-3333-4333-8333-333333333333', approved_at=now() WHERE id='f5500000-0000-4000-8000-00000000000b';

SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid='public.approval_requests'::regclass), 'RLS enabled and forced'); -- 1
SELECT ok(NOT has_table_privilege('authenticated','public.approval_requests','INSERT')
  AND NOT has_table_privilege('authenticated','public.approval_requests','UPDATE')
  AND NOT has_table_privilege('authenticated','public.approval_requests','DELETE')
  AND NOT has_table_privilege('anon','public.approval_requests','SELECT'), 'no direct writes; anon has nothing'); -- 2

-- member A2 requests approval
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT ok(public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('1',64),'[{"label":"to","value":"ACME"}]','Month end') IS NOT NULL, 'member creates a request'); -- 3
SELECT is(public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('1',64),'[]',NULL),
  (SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('1',64)), 'creating the same pending request is idempotent'); -- 4
SELECT is((SELECT permission_class FROM public.approval_requests WHERE arguments_sha256=repeat('1',64)), 'write', 'permission class comes from the approved snapshot'); -- 5
SELECT throws_ok($$SELECT public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000a','external.list_invoices',repeat('1',64),'[]',NULL)$$, '22023', 'INVALID_CAPABILITY', 'read tools never need approval'); -- 6
SELECT throws_ok($$SELECT public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a1',
  'f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('1',64),'[]',NULL)$$, '22023', 'INVALID_THREAD', 'cannot request on someone else''s thread'); -- 7
SELECT throws_ok($$SELECT public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000b','external.send_invoice',repeat('1',64),'[]',NULL)$$, '22023', 'INVALID_ENDPOINT', 'cannot request against another tenant''s endpoint'); -- 8
SELECT throws_ok($$SELECT public.create_approval_request('f5b00000-0000-4000-8000-00000000000b','f5700000-0000-4000-8000-0000000000b1',
  'f5e00000-0000-4000-8000-00000000000b','external.send_invoice',repeat('1',64),'[]',NULL)$$, '42501', 'FORBIDDEN', 'cannot request in an organization one is not a member of'); -- 9
SELECT throws_ok($$SELECT * FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests LIMIT 1),'approve')$$, '42501', 'FORBIDDEN', 'a requester cannot approve their own request'); -- 10
SELECT throws_ok($$INSERT INTO public.approval_requests (organization_id, requested_by, connection_id, capability, permission_class, arguments_sha256)
  VALUES ('f5a00000-0000-4000-8000-00000000000a','f5222222-2222-4222-8222-222222222222','f5e00000-0000-4000-8000-00000000000a','external.send_invoice','write',repeat('9',64))$$,
  '42501', NULL, 'direct inserts are refused'); -- 11
SELECT is((SELECT status FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','mine')), 'pending', 'history shows pending'); -- 12
SELECT throws_ok($$SELECT * FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','org')$$, '42501', 'FORBIDDEN', 'members cannot read org history'); -- 13
SELECT ok(public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('2',64),'[]',NULL) IS NOT NULL, 'second request'); -- 14
SELECT ok(public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('3',64),'[]',NULL) IS NOT NULL, 'third request'); -- 15
SELECT ok(public.cancel_approval_request('f5a00000-0000-4000-8000-00000000000a',(SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('3',64))), 'requester cancels'); -- 16
SELECT ok(public.create_approval_request('f5a00000-0000-4000-8000-00000000000a','f5700000-0000-4000-8000-0000000000a2',
  'f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('4',64),'[]',NULL) IS NOT NULL, 'fourth request (will expire)'); -- 17

-- owner B1: cannot see or decide org A requests
SELECT set_config('request.jwt.claims','{"sub":"f5333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.approval_requests), 0, 'another tenant''s owner sees no requests'); -- 18
SELECT throws_ok($$SELECT * FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  'f5a00000-0000-4000-8000-00000000ffff','approve')$$, '42501', 'FORBIDDEN', 'another tenant''s owner cannot decide'); -- 19
SELECT throws_ok($$SELECT * FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','mine')$$, '42501', 'FORBIDDEN', 'another tenant cannot read history'); -- 20
SELECT ok(public.create_approval_request('f5b00000-0000-4000-8000-00000000000b','f5700000-0000-4000-8000-0000000000b1',
  'f5e00000-0000-4000-8000-00000000000b','external.send_invoice',repeat('5',64),'[]',NULL) IS NOT NULL, 'B creates its own request'); -- 21

RESET ROLE;
UPDATE public.approval_requests SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE arguments_sha256=repeat('4',64);
SET LOCAL ROLE authenticated;

-- owner A1 decides
SELECT set_config('request.jwt.claims','{"sub":"f5111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.approval_requests), 4, 'org owner sees the org''s requests, not B''s'); -- 22
SELECT throws_ok($$SELECT * FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests WHERE false UNION ALL SELECT 'f5a00000-0000-4000-8000-00000000ffff'::uuid LIMIT 1),'approve')$$, 'P0002', 'NOT_FOUND', 'unknown request'); -- 23
SELECT is((SELECT decision FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('1',64)),'approve',600,'ok for month end')), 'approved', 'owner approves'); -- 24
SELECT is((SELECT requested_by FROM public.tool_approvals WHERE arguments_sha256=repeat('1',64)),
  'f5222222-2222-4222-8222-222222222222'::uuid, 'approval recorded through Agent 2''s record_tool_approval for the requester'); -- 25
SELECT throws_ok($$SELECT * FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('1',64)),'reject')$$, '55000', 'ALREADY_DECIDED', 'decisions are final'); -- 26
SELECT is((SELECT decision FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('2',64)),'reject',900,'not now')), 'rejected', 'owner rejects'); -- 27
SELECT throws_ok($$SELECT * FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('4',64)),'approve')$$, '55000', 'REQUEST_EXPIRED', 'expired requests cannot be approved'); -- 28
SELECT throws_ok($$SELECT * FROM public.decide_approval_request('f5a00000-0000-4000-8000-00000000000a',
  (SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('1',64)),'maybe')$$, '22023', 'INVALID_DECISION', 'decision is validated'); -- 29
SELECT ok(NOT public.cancel_approval_request('f5a00000-0000-4000-8000-00000000000a',(SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('4',64))), 'only the requester can cancel'); -- 30
-- a direct (card) approval without a request shows up in history as source 'direct'
SELECT ok((SELECT id FROM public.record_tool_approval('f5a00000-0000-4000-8000-00000000000a','f5e00000-0000-4000-8000-00000000000a',
  'external.send_invoice',repeat('6',64),300,'f5700000-0000-4000-8000-0000000000a2')) IS NOT NULL, 'direct approval'); -- 31
SELECT is((SELECT string_agg(status || ':' || source, ',' ORDER BY arguments_sha256) FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','org')),
  'approved:request,rejected:request,cancelled:request,expired:request,approved:direct', 'org history covers every state and both sources'); -- 32
SELECT ok(public.revoke_approval_request('f5a00000-0000-4000-8000-00000000000a',(SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('1',64))), 'owner revokes through Agent 2''s revoke_tool_approval'); -- 33
SELECT is((SELECT status FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','org','revoked')), 'revoked', 'revoked status'); -- 34
SELECT ok(NOT public.revoke_approval_request('f5a00000-0000-4000-8000-00000000000a',(SELECT id FROM public.approval_requests WHERE arguments_sha256=repeat('1',64))), 'a second revoke is a no-op'); -- 39

SELECT set_config('request.jwt.claims','{"sub":"f5222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','mine')), 5, 'requester sees own history incl. direct approval'); -- 35
SELECT ok(public.claim_tool_approval('f5a00000-0000-4000-8000-00000000000a','f5e00000-0000-4000-8000-00000000000a','external.send_invoice',repeat('6',64),'f5700000-0000-4000-8000-0000000000a2'), 'requester''s tool call consumes the direct approval (Agent 2 claim)'); -- 36
SELECT is((SELECT status FROM public.list_approval_history('f5a00000-0000-4000-8000-00000000000a','mine','used')), 'used', 'a consumed approval shows as used'); -- 37

RESET ROLE;
SELECT is((SELECT array_agg(DISTINCT action ORDER BY action) FROM public.audit_logs WHERE organization_id='f5a00000-0000-4000-8000-00000000000a' AND action LIKE 'workspace.approval.%'),
  ARRAY['workspace.approval.approved','workspace.approval.cancelled','workspace.approval.rejected','workspace.approval.requested','workspace.approval.revoked'], 'approval lifecycle is audited, including revocation'); -- 38
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id='f5a00000-0000-4000-8000-00000000000a' AND action='workspace.approval.revoked'), 1, 'only the effective revoke is audited'); -- 40

SELECT * FROM finish();
ROLLBACK;
