-- workspace_message_citations.test.sql — 20261120100010: assistant messages keep
-- the citations streamed with the turn (exact Citation shape, bounded), plus
-- knowledge_unavailable; only on assistant messages; append-only; readable by
-- the thread owner only, never across users or tenants. Also: the thread's
-- agent_id is visible to its owner only.
-- Q-9c (F-2/F-3): assistant rows are written by the server only
-- (append_chat_message_server as sso_control) and authenticated has no column
-- SELECT on citations; stored values are read back as the table owner here,
-- reader-side filtering is covered by workspace_message_citations_confidential.
BEGIN;
SELECT plan(31);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','ea111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_mc_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ea222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_mc_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ea333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_mc_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('eaa00000-0000-4000-8000-00000000000a','Citations A','ws-mc-a'), ('eab00000-0000-4000-8000-00000000000b','Citations B','ws-mc-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','owner'),
 ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','agent'),
 ('eab00000-0000-4000-8000-00000000000b','ea333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.custom_agents (id, organization_id, owner_user_id, name, instructions, visibility) VALUES
 ('ead00000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Desk','Rules.','private');
-- The member's agent thread and plain thread; one thread in B.
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key, agent_id) VALUES
 ('ea700000-0000-4000-8000-0000000000a1','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Agent chat','it-model','ead00000-0000-4000-8000-000000000001'),
 ('ea700000-0000-4000-8000-0000000000a2','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Plain chat','it-model',NULL),
 ('ea700000-0000-4000-8000-0000000000b1','eab00000-0000-4000-8000-00000000000b','ea333333-3333-4333-8333-333333333333','B chat','it-model',NULL);

CREATE TEMP TABLE c (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT SELECT ON c TO authenticated, sso_control;
INSERT INTO c VALUES ('one', '{"n":1,"documentId":"ea0d0000-0000-4000-8000-000000000001","collectionId":"eac00000-0000-4000-8000-000000000001","fileId":"eaf00000-0000-4000-8000-000000000001","title":"roadmap.md","ordinal":0,"snippet":"The quantum ledger migration ships in Q2."}');

SELECT has_column('public','chat_messages','citations','chat_messages.citations exists'); -- 1
SELECT is((SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.chat_messages'::regclass AND a.attname = 'citations'), '''[]''::jsonb', 'citations defaults to []'); -- 2
SELECT col_not_null('public','chat_messages','knowledge_unavailable','knowledge_unavailable is NOT NULL'); -- 3
SELECT ok((SELECT p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc p
  WHERE p.oid = 'private.valid_message_citations(jsonb)'::regprocedure), 'validator: IMMUTABLE, INVOKER, pinned search_path'); -- 4
SELECT ok(NOT has_function_privilege('anon','private.valid_message_citations(jsonb)','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = 'private.valid_message_citations(jsonb)'::regprocedure
                  AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'), 'validator: no PUBLIC/anon execute'); -- 5
SELECT ok(NOT has_table_privilege('authenticated','public.chat_messages','UPDATE')
  AND NOT has_column_privilege('authenticated','public.chat_messages','citations','UPDATE'), 'messages stay append-only for users'); -- 6

-- Runs the server RPC AS sso_control (EXECUTE is checked for that role), then
-- restores the caller's role. pgTAP itself is not resolvable by sso_control (no
-- USAGE on extensions), so the assertions stay outside the role switch; on error
-- the enclosing subtransaction restores the role.
CREATE FUNCTION pg_temp.ctl(p_org uuid, p_user uuid, p_thread uuid, p_role text, p_content text, p jsonb DEFAULT '[]', p_ku boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v jsonb;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.append_chat_message_server(p_org, p_user, p_thread, p_role, p_content, 'complete', NULL, '[]'::jsonb, NULL, p, p_ku);
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.srv(p_thread uuid, p_content text, p jsonb DEFAULT '[]', p_role text DEFAULT 'assistant', p_ku boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.ctl('eaa00000-0000-4000-8000-00000000000a', 'ea222222-2222-4222-8222-222222222222', p_thread, p_role, p_content, p, p_ku) $f$;

-- Valid: the streamed shape, two entries.
SELECT lives_ok($$SELECT set_config('t.m1', pg_temp.srv('ea700000-0000-4000-8000-0000000000a1', 'Answer [1] [2]',
  (SELECT jsonb_build_array(v, v || '{"n":2,"ordinal":3}') FROM c WHERE k = 'one'))->>'id', true)$$,
  'server stores an assistant answer with citations'); -- 7
RESET ROLE;
SELECT is((SELECT citations FROM public.chat_messages WHERE id = current_setting('t.m1')::uuid),
  (SELECT jsonb_build_array(v, v || '{"n":2,"ordinal":3}') FROM c WHERE k = 'one'), 'citations stored unchanged'); -- 8
SELECT lives_ok($$SELECT pg_temp.srv('ea700000-0000-4000-8000-0000000000a1', 'No knowledge this time', '[]', 'assistant', true)$$,
  'assistant answer with knowledge_unavailable and no citations'); -- 9
SELECT lives_ok($$SELECT set_config('t.m2', pg_temp.srv('ea700000-0000-4000-8000-0000000000a2', 'Plain answer')->>'id', true)$$,
  'plain chat answer without the new columns'); -- 10
RESET ROLE;
SELECT is((SELECT (citations, knowledge_unavailable)::text FROM public.chat_messages WHERE id = current_setting('t.m2')::uuid),
  '([],f)', 'plain answer gets [] / false'); -- 11

-- Shape violations are rejected by the CHECK (23514), never stored.
CREATE FUNCTION pg_temp.bad(p jsonb, p_role text DEFAULT 'assistant', p_ku boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.srv('ea700000-0000-4000-8000-0000000000a1', 'x', p, p_role, p_ku) $f$;
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"url":"https://evil.example"}') FROM c))$$, '23514', NULL, 'extra key rejected'); -- 12
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v - 'snippet') FROM c))$$, '23514', NULL, 'missing key rejected'); -- 13
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"documentId":"EA0D0000-0000-4000-8000-000000000001"}') FROM c))$$, '23514', NULL, 'non-canonical uuid rejected'); -- 14
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"fileId":"../../etc/passwd"}') FROM c))$$, '23514', NULL, 'non-uuid id rejected'); -- 15
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"n":0}') FROM c))$$, '23514', NULL, 'n must be >= 1'); -- 16
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"n":"1"}') FROM c))$$, '23514', NULL, 'n must be a number'); -- 17
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"ordinal":1.5}') FROM c))$$, '23514', NULL, 'ordinal must be an integer'); -- 18
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || jsonb_build_object('snippet', repeat('x', 2001))) FROM c))$$, '23514', NULL, 'snippet over 2000 rejected'); -- 19
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_build_array(v || '{"title":""}') FROM c))$$, '23514', NULL, 'empty title rejected'); -- 20
SELECT throws_ok($$SELECT pg_temp.bad((SELECT jsonb_agg(v) FROM c, generate_series(1, 21)))$$, '23514', NULL, 'more than 20 citations rejected'); -- 21
SELECT throws_ok($$SELECT pg_temp.bad('{"n":1}'::jsonb)$$, '23514', NULL, 'object instead of array rejected'); -- 22
SELECT throws_ok($$SELECT pg_temp.bad('["x", 1]'::jsonb)$$, '23514', NULL, 'scalar elements rejected (CHECK, not a runtime error)'); -- 23
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"ea222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, citations)
  SELECT 'ea700000-0000-4000-8000-0000000000a2','eaa00000-0000-4000-8000-00000000000a','user','x', jsonb_build_array(v) FROM c$$,
  '42501', NULL, 'user messages cannot carry citations (no INSERT grant on citations)'); -- 24
SELECT throws_ok($$SELECT pg_temp.bad('[]'::jsonb, 'tool', true)$$, '23514', NULL, 'tool messages cannot carry knowledge_unavailable'); -- 25
SET LOCAL ROLE authenticated;
SELECT throws_ok($$UPDATE public.chat_messages SET citations = '[]' WHERE id = current_setting('t.m1')::uuid$$,
  '42501', NULL, 'stored citations cannot be edited afterwards'); -- 26

-- Same org, other user: neither the messages nor the thread's agent binding.
SELECT set_config('request.jwt.claims','{"sub":"ea111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE thread_id = 'ea700000-0000-4000-8000-0000000000a1'), 0,
  'org owner cannot read another member''s cited answers'); -- 27
SELECT is((SELECT count(*)::int FROM public.chat_threads WHERE agent_id = 'ead00000-0000-4000-8000-000000000001'), 0,
  'org owner cannot discover which threads use the agent'); -- 28
-- Other tenant: no read, no write into A's thread.
SELECT set_config('request.jwt.claims','{"sub":"ea333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE organization_id = 'eaa00000-0000-4000-8000-00000000000a'), 0,
  'other tenant cannot read A''s cited answers'); -- 29
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, citations)
  SELECT 'ea700000-0000-4000-8000-0000000000a1','eaa00000-0000-4000-8000-00000000000a','assistant','forged', jsonb_build_array(v) FROM c$$,
  '42501', NULL, 'other tenant cannot plant citations in A''s thread'); -- 30
-- The owner sees the binding.
SELECT set_config('request.jwt.claims','{"sub":"ea222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT agent_id FROM public.chat_threads WHERE id = 'ea700000-0000-4000-8000-0000000000a1'), 'ead00000-0000-4000-8000-000000000001'::uuid,
  'thread owner reads the agent binding'); -- 31

SELECT * FROM finish();
ROLLBACK;
