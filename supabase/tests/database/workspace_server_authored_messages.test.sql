-- workspace_server_authored_messages.test.sql — 20261120200003 (Q-9c, F-3):
-- an authenticated user can append only role='user' messages to their own
-- open thread, with only the user-message columns. Assistant and tool messages
-- are written by the server alone through append_chat_message_server
-- (sso_control), which re-checks owner, organization, membership and archive
-- state for the user it acts for; the table CHECKs still apply.
BEGIN;
SELECT plan(36);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e5111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_sam_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e5222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_sam_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e5333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_sam_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e5a00000-0000-4000-8000-00000000000a','Authored A','ws-sam-a'), ('e5b00000-0000-4000-8000-00000000000b','Authored B','ws-sam-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e5a00000-0000-4000-8000-00000000000a','e5111111-1111-4111-8111-111111111111','owner'),
 ('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','agent'),
 ('e5b00000-0000-4000-8000-00000000000b','e5333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key, archived_at) VALUES
 ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','Open','it-model',NULL),
 ('e5700000-0000-4000-8000-0000000000a2','e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','Archived','it-model',now()),
 ('e5700000-0000-4000-8000-0000000000b1','e5b00000-0000-4000-8000-00000000000b','e5333333-3333-4333-8333-333333333333','B','it-model',NULL);
CREATE TEMP TABLE c (v jsonb) ON COMMIT DROP;
GRANT SELECT ON c TO authenticated;
INSERT INTO c VALUES ('{"n":1,"documentId":"e50d0000-0000-4000-8000-000000000001","collectionId":"e5c00000-0000-4000-8000-000000000001","fileId":"e5f00000-0000-4000-8000-000000000001","title":"forged.md","ordinal":0,"snippet":"FORGED"}');

-- Runs append_chat_message_server AS sso_control (pgTAP is not resolvable by that role).
CREATE FUNCTION pg_temp.ctl(p_org uuid, p_user uuid, p_thread uuid, p_role text, p_content text DEFAULT 'server text',
  p_cap text DEFAULT NULL, p jsonb DEFAULT '[]', p_ku boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v jsonb;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.append_chat_message_server(p_org, p_user, p_thread, p_role, p_content, 'complete', 'it-model', '[]'::jsonb, p_cap, p, p_ku);
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;

-- Schema (as postgres).
SELECT ok((SELECT with_check LIKE '%role = ''user''::text%' FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'messages_owner_append'),
  'INSERT policy requires role = user'); -- 1
SELECT is((SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'chat_messages' AND grantee = 'authenticated' AND privilege_type = 'INSERT'),
  'content,mentions,model_key,organization_id,role,status,thread_id', 'authenticated INSERT limited to the user-message columns'); -- 2
SELECT ok((SELECT prosecdef AND provolatile = 'v' AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
  WHERE oid = 'public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)'::regprocedure),
  'server RPC: SECURITY DEFINER, VOLATILE, pinned search_path'); -- 3
SELECT ok(has_function_privilege('sso_control','public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)','EXECUTE')
  AND NOT has_function_privilege('anon','public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                  WHERE p.oid = 'public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)'::regprocedure AND x.grantee = 0),
  'server RPC: sso_control yes; authenticated, anon, PUBLIC no'); -- 4
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sso_control' AND (rolsuper OR rolbypassrls OR rolcanlogin)),
  'sso_control: no login, no superuser, no bypassrls'); -- 5

-- The thread owner, directly (what a forged PostgREST call would run).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e5222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','assistant','Forged answer')$$,
  '42501', NULL, 'owner cannot insert an assistant message'); -- 6
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','tool','{"ok":true}')$$,
  '42501', NULL, 'owner cannot insert a tool message'); -- 7
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, citations)
  SELECT 'e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','assistant','Forged [1]', jsonb_build_array(v) FROM c$$,
  '42501', NULL, 'owner cannot insert an assistant message with fabricated citations'); -- 8
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, knowledge_unavailable)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','assistant','x', true)$$,
  '42501', NULL, 'owner cannot set knowledge_unavailable'); -- 9
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, capability_key)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','user','x','calendar.find_availability')$$,
  '42501', NULL, 'owner cannot set capability_key'); -- 10
SELECT throws_ok($$INSERT INTO public.chat_messages (id, thread_id, organization_id, role, content)
  VALUES (gen_random_uuid(),'e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','user','x')$$,
  '42501', NULL, 'owner cannot choose the id'); -- 11
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, created_at)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','user','x', now() - interval '1 year')$$,
  '42501', NULL, 'owner cannot back-date a message'); -- 12
SELECT lives_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, model_key, mentions, status)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','user','Hello','it-model','[]','complete')$$,
  'owner appends a user message (the columns the app sends)'); -- 13
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content)
  VALUES ('e5700000-0000-4000-8000-0000000000a2','e5a00000-0000-4000-8000-00000000000a','user','x')$$,
  '42501', NULL, 'not into an archived thread'); -- 14
SELECT throws_ok($$SELECT public.append_chat_message_server('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222',
  'e5700000-0000-4000-8000-0000000000a1','assistant','Forged via RPC')$$, '42501', NULL, 'authenticated cannot call the server RPC'); -- 15
SELECT set_config('request.jwt.claims','{"sub":"e5111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content)
  VALUES ('e5700000-0000-4000-8000-0000000000a1','e5a00000-0000-4000-8000-00000000000a','user','x')$$,
  '42501', NULL, 'org owner cannot write into a member''s thread'); -- 16
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.append_chat_message_server('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222',
  'e5700000-0000-4000-8000-0000000000a1','assistant','x')$$, '42501', NULL, 'anon cannot call the server RPC'); -- 17
RESET ROLE;

-- The server path.
SELECT is((SELECT (v->>'role') || ':' || (v->>'content') || ':' || (v->'citations'->0->>'snippet') || ':' || (v->>'knowledge_unavailable')
  FROM (SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1',
    'assistant','Answer [1]', NULL, (SELECT jsonb_build_array(v) FROM c)) v) s), 'assistant:Answer [1]:FORGED:false',
  'server stores an assistant answer with citations'); -- 18
SELECT is((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222',
  'e5700000-0000-4000-8000-0000000000a1','assistant','Second',NULL,'[]',true)) k),
  'capability_key,citations,content,created_at,id,knowledge_unavailable,mentions,role,status', 'returns exactly the message columns the app reads'); -- 19
SELECT is((SELECT (v->>'role') || ':' || (v->>'capability_key') FROM (SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222',
  'e5700000-0000-4000-8000-0000000000a1','tool','{"ok":true}','calendar.find_availability') v) s), 'tool:calendar.find_availability', 'server stores a tool result'); -- 20
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','user')$$,
  '22023', 'INVALID_REQUEST', 'the server RPC never writes user messages'); -- 21
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','system')$$,
  '22023', 'INVALID_REQUEST', 'unknown roles rejected'); -- 22
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1',NULL)$$,
  '22023', 'INVALID_REQUEST', 'NULL role rejected'); -- 23
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a',NULL,'e5700000-0000-4000-8000-0000000000a1','assistant')$$,
  '22023', 'INVALID_REQUEST', 'NULL user rejected'); -- 24
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5111111-1111-4111-8111-111111111111','e5700000-0000-4000-8000-0000000000a1','assistant')$$,
  'P0002', 'NOT_FOUND', 'acting for a user who does not own the thread: NOT_FOUND'); -- 25
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a2','assistant')$$,
  'P0002', 'NOT_FOUND', 'archived thread: NOT_FOUND'); -- 26
SELECT throws_ok($$SELECT pg_temp.ctl('e5b00000-0000-4000-8000-00000000000b','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','assistant')$$,
  'P0002', 'NOT_FOUND', 'wrong organization: NOT_FOUND'); -- 27
SELECT throws_ok($$SELECT pg_temp.ctl('e5b00000-0000-4000-8000-00000000000b','e5333333-3333-4333-8333-333333333333','e5700000-0000-4000-8000-0000000000a1','assistant')$$,
  'P0002', 'NOT_FOUND', 'other tenant user for A''s thread: NOT_FOUND'); -- 28
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000b1','assistant')$$,
  'P0002', 'NOT_FOUND', 'A user into B''s thread: NOT_FOUND'); -- 29
DELETE FROM public.organization_members WHERE user_id = 'e5222222-2222-4222-8222-222222222222';
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','assistant')$$,
  'P0002', 'NOT_FOUND', 'removed member: NOT_FOUND'); -- 30
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','agent');
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','assistant','x',NULL,'[{}]')$$,
  '23514', NULL, 'table CHECKs still apply (malformed citations)'); -- 31
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','assistant','x','calendar.find_availability')$$,
  '23514', NULL, 'table CHECKs still apply (capability_key only on tool)'); -- 32
SELECT throws_ok($$SELECT pg_temp.ctl('e5a00000-0000-4000-8000-00000000000a','e5222222-2222-4222-8222-222222222222','e5700000-0000-4000-8000-0000000000a1','assistant',repeat('x',100001))$$,
  '23514', NULL, 'table CHECKs still apply (content size)'); -- 33

-- The owner reads the server-authored history; still append-only.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e5222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT string_agg(role, ',' ORDER BY created_at, role) FROM public.chat_messages WHERE thread_id = 'e5700000-0000-4000-8000-0000000000a1'),
  'assistant,assistant,tool,user', 'owner reads the user + server-authored messages'); -- 34
SELECT throws_ok($$UPDATE public.chat_messages SET role = 'user' WHERE thread_id = 'e5700000-0000-4000-8000-0000000000a1'$$, '42501', NULL, 'still no UPDATE'); -- 35
SELECT throws_ok($$DELETE FROM public.chat_messages WHERE thread_id = 'e5700000-0000-4000-8000-0000000000a1'$$, '42501', NULL, 'still no DELETE'); -- 36
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
