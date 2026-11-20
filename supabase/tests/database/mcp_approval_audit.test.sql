-- pgTAP: MCP approval audit (20261120000010_mcp_approval_audit.sql).
-- Self-contained fixtures, rolled back. Every approval decision writes one
-- classified, append-only, tenant-isolated event that never holds arguments.
BEGIN;
SELECT plan(44);

-- Fixtures (as postgres) ----------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'audit-owner@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'audit-member@example.test'),
  ('a0000000-0000-4000-8000-000000000003', 'audit-foreign@example.test');
INSERT INTO public.organizations (id, name, slug) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'Audit Org A', 'audit-org-a-test'),
  ('b0000000-0000-4000-8000-000000000002', 'Audit Org B', 'audit-org-b-test');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner'),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'agent'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', 'owner');
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'mcp', 'https://mcp.example.test/rpc', 'Audit MCP', 'active');
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 1, repeat('0', 64));
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'create_entities', 'w', '{}'::jsonb, 'write'),
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'read_graph', 'r', '{}'::jsonb, 'read');
-- Approve only after the tools exist (approved snapshots are immutable).
UPDATE public.external_tool_snapshots SET approved_by = 'a0000000-0000-4000-8000-000000000001', approved_at = now()
  WHERE id = 'd0000000-0000-4000-8000-000000000001';
-- The member's chat thread: the member is the requester of every approval.
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, model_key) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'demo');

-- Shape and privileges ------------------------------------------------------
SELECT has_table('public', 'mcp_approval_events', 'A1: mcp_approval_events exists');
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.mcp_approval_events'::regclass),
  'A2: RLS enabled and forced');
SELECT is((SELECT array_agg(column_name::text ORDER BY column_name::text) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'mcp_approval_events'),
  ARRAY['actor_user_id','approval_id','arguments_sha256','capability','created_at','endpoint_id','event','id','organization_id','reason','thread_id'],
  'A3: exactly these columns; no arguments, no secrets, only the argument hash');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mcp_approval_events', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.mcp_approval_events', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.mcp_approval_events', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.mcp_approval_events', 'SELECT'),
  'A4: no direct writes for authenticated, nothing for anon');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_tool_approval(uuid,uuid,text,text,uuid)', 'EXECUTE'),
  'A5: the unaudited claim can no longer be called by users');
SELECT ok(has_function_privilege('authenticated', 'public.claim_tool_approval_audited(uuid,uuid,text,text,uuid,text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.reject_tool_call(uuid,uuid,text,text,uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.record_mcp_approval_event(uuid,text,text,uuid,text,text,uuid)', 'EXECUTE'),
  'A6: audited functions are callable by users');

-- Approved (owner records for the member's thread) ---------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT lives_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('a',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'A7: owner approves call a');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.mcp_approval_events WHERE event = 'approved' AND arguments_sha256 = repeat('a',64)
           AND actor_user_id = 'a0000000-0000-4000-8000-000000000001' AND approval_id IS NOT NULL
           AND thread_id = 'f0000000-0000-4000-8000-000000000001' AND endpoint_id = 'c0000000-0000-4000-8000-000000000001'), 1,
  'A8: approved event with approver, approval, thread and endpoint');

-- Member claims -------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('b',64), 'f0000000-0000-4000-8000-000000000001','chat_turn')),
  '(f,APPROVAL_REQUIRED)', 'A9: chat turn without an approval for these arguments asks for one');
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('b',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,ARGUMENTS_MISMATCH)', 'A10: approved-call with other arguments than the approved ones');
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('a',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(t,OK)', 'A11: the approved call is claimed');
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('a',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,ALREADY_USED)', 'A12: a second claim is a replay');
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('9',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,NO_APPROVAL)', 'A13: approved-call with nothing approved on this thread for the tool');
SELECT throws_ok($$SELECT * FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('a',64), 'f0000000-0000-4000-8000-000000000001','other')$$,
  '22023', NULL, 'A14: unknown source is refused');
RESET ROLE;
SELECT is((SELECT array_agg(event || ':' || coalesce(reason,'-') ORDER BY created_at, event) FROM public.mcp_approval_events
           WHERE actor_user_id = 'a0000000-0000-4000-8000-000000000002'),
  ARRAY['approval_requested:APPROVAL_REQUIRED','authorization_denied:NO_APPROVAL','claimed:-','invalid_arguments:ARGUMENTS_MISMATCH','replayed:ALREADY_USED'],
  'A15: one classified event per decision');
SELECT is((SELECT count(*)::int FROM public.mcp_approval_events e JOIN public.tool_approvals a ON a.id = e.approval_id
           WHERE e.event = 'claimed' AND a.arguments_sha256 = repeat('a',64) AND a.used_at IS NOT NULL), 1,
  'A16: the claimed event names the consumed approval');

-- Executed / execution_failed (trusted audit writer only) --------------------
SELECT lives_ok($$SELECT public.record_mcp_tool_call('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002','external.create_entities','ok',NULL,12, repeat('a',64))$$, 'A17: runtime audits the run');
SELECT is((SELECT count(*)::int FROM public.mcp_approval_events WHERE event = 'executed' AND arguments_sha256 = repeat('a',64)
           AND approval_id IS NOT NULL), 1, 'A18: executed event linked to the approval');
SELECT lives_ok($$SELECT public.record_mcp_tool_call('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002','external.create_entities','ok',NULL,12, repeat('a',64))$$, 'A19: a second audit row');
SELECT is((SELECT count(*)::int FROM public.mcp_approval_events WHERE event IN ('executed','execution_failed') AND arguments_sha256 = repeat('a',64)), 1,
  'A20: an audit row without an open claim adds no execution event');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT lives_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('7',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'A21: owner approves call 7');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is((SELECT claimed FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('7',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  true, 'A22: call 7 claimed');
RESET ROLE;
SELECT lives_ok($$SELECT public.record_mcp_tool_call('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002','external.create_entities','TOOL_ERROR','TOOL_ERROR',5, repeat('7',64))$$, 'A23: run fails');
SELECT is((SELECT reason FROM public.mcp_approval_events WHERE event = 'execution_failed' AND arguments_sha256 = repeat('7',64)), 'TOOL_ERROR',
  'A24: execution_failed with the runtime outcome');

-- Expired -------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT lives_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('c',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'A25: owner approves call c');
RESET ROLE;
UPDATE public.tool_approvals SET expires_at = now() - interval '1 second' WHERE arguments_sha256 = repeat('c',64);
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('c',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,EXPIRED)', 'A26: expired approval');

-- Revoked -------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT lives_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('d',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'A27: owner approves call d');
SELECT is(public.revoke_tool_approval('b0000000-0000-4000-8000-000000000001',
  (SELECT id FROM public.tool_approvals WHERE arguments_sha256 = repeat('d',64))), true, 'A28: owner revokes it');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('d',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,CLAIM_AFTER_REVOKE)', 'A29: revoked approval is refused');
RESET ROLE;
SELECT is((SELECT array_agg(event || ':' || coalesce(reason,'-') || ':' || (actor_user_id = 'a0000000-0000-4000-8000-000000000001')::text ORDER BY created_at, event)
           FROM public.mcp_approval_events WHERE arguments_sha256 = repeat('d',64)),
  ARRAY['approved:-:true','revoked:CLAIM_AFTER_REVOKE:false','revoked:REVOKED_BY_ADMIN:true'], 'A30: revoke recorded with the revoking admin');

-- Not the requester ----------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT lives_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('6',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'A31: owner approves call 6');
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('6',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,NOT_REQUESTER)', 'A32: only the requester can run an approved call');

-- Rejected by the user is binding ---------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is((SELECT reason FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('e',64), 'f0000000-0000-4000-8000-000000000001','chat_turn')),
  'APPROVAL_REQUIRED', 'A33: call e is proposed');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT lives_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('e',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'A34: approved in another tab');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is(public.reject_tool_call('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('e',64), 'f0000000-0000-4000-8000-000000000001'), 1, 'A35: reject revokes the open approval');
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('e',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,CLAIM_AFTER_REJECT)', 'A36: a rejected call never runs');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
SELECT throws_ok($$SELECT public.record_tool_approval('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('e',64), 600, 'f0000000-0000-4000-8000-000000000001')$$, 'P0001', 'CALL_REJECTED', 'A37: a rejected call cannot be re-approved');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}';
SELECT throws_ok($$SELECT public.reject_tool_call('b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',
  'external.create_entities', repeat('e',64), 'f0000000-0000-4000-8000-000000000001')$$, '42501', NULL, 'A38: foreign user cannot reject');

-- Foreign tenant --------------------------------------------------------------
SELECT is((SELECT row(claimed, reason)::text FROM public.claim_tool_approval_audited('b0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001','external.create_entities', repeat('a',64), 'f0000000-0000-4000-8000-000000000001','approved_call')),
  '(f,FORBIDDEN)', 'A39: foreign claim refused');
SELECT throws_ok($$SELECT public.record_mcp_approval_event('b0000000-0000-4000-8000-000000000001','authorization_denied','FOREIGN_TENANT',
  NULL,'external.create_entities',repeat('a',64),NULL)$$, '42501', NULL, 'A40: cannot write into a foreign org');
SELECT lives_ok($$SELECT public.record_mcp_approval_event('b0000000-0000-4000-8000-000000000002','authorization_denied','FOREIGN_TENANT',
  'c0000000-0000-4000-8000-000000000001','external.create_entities',repeat('a',64),'f0000000-0000-4000-8000-000000000001')$$,
  'A41: foreign attempt recorded in the actor''s own org');
SELECT throws_ok($$SELECT public.record_mcp_approval_event('b0000000-0000-4000-8000-000000000002','executed',NULL,
  NULL,'external.create_entities',repeat('a',64),NULL)$$, '22023', NULL, 'A42: users cannot write execution events');
-- RLS: the foreign owner sees only its org's row, with org A ids removed.
SELECT is((SELECT array_agg(organization_id::text || ':' || coalesce(endpoint_id::text,'null') || ':' || coalesce(thread_id::text,'null'))
           FROM public.mcp_approval_events),
  ARRAY['b0000000-0000-4000-8000-000000000002:null:null'], 'A43: tenant isolation; foreign ids never stored');
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.mcp_approval_events), 0, 'A44: non-admin members cannot read the audit');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
