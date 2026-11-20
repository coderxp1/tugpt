-- workspace_chat_turns.test.sql — 20261121100001 (Q-12): idempotent chat turns.
-- One user message per (thread, turn); users stamp turn ids only on their own
-- user messages; append_chat_turn_message_server (sso_control only) answers
-- only a turn opened in that very thread, for the thread's owner; the old
-- append_chat_message_server is unchanged; turn ids never cross tenants.
BEGIN;
SELECT plan(26);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e6111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_turn_a1@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e6222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_turn_a2@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e6333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_turn_b1@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e6a00000-0000-4000-8000-00000000000a','Turns A','ws-turn-a'), ('e6b00000-0000-4000-8000-00000000000b','Turns B','ws-turn-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','agent'),
 ('e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','agent'),
 ('e6b00000-0000-4000-8000-00000000000b','e6333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('e6700000-0000-4000-8000-0000000000a1','e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','A1 first','it-model'),
 ('e6700000-0000-4000-8000-0000000000a3','e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','A1 second','it-model'),
 ('e6700000-0000-4000-8000-0000000000a2','e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','A2','it-model'),
 ('e6700000-0000-4000-8000-0000000000b1','e6b00000-0000-4000-8000-00000000000b','e6333333-3333-4333-8333-333333333333','B1','it-model');

CREATE FUNCTION pg_temp.turn(p_org uuid, p_user uuid, p_thread uuid, p_turn uuid, p_role text DEFAULT 'assistant',
  p_status text DEFAULT 'complete') RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v jsonb;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.append_chat_turn_message_server(p_org, p_user, p_thread, p_turn, p_role, 'answer', p_status, 'it-model');
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.as_user(p_sub text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;

-- Schema and grants (as postgres).
SELECT col_type_is('public', 'chat_messages', 'turn_id', 'uuid', 'turn_id is a uuid'); -- 1
SELECT col_is_null('public', 'chat_messages', 'turn_id', 'turn_id is nullable (existing rows keep NULL)'); -- 2
SELECT ok((SELECT indisunique AND pg_get_expr(indpred, indrelid) LIKE '%role = ''user''%' FROM pg_index
  WHERE indexrelid = 'public.chat_messages_user_turn_unique'::regclass), 'one user message per (thread, turn)'); -- 3
SELECT ok(has_column_privilege('authenticated', 'public.chat_messages', 'turn_id', 'SELECT'), 'authenticated reads turn_id'); -- 4
SELECT ok(has_column_privilege('authenticated', 'public.chat_messages', 'turn_id', 'INSERT'), 'authenticated writes turn_id'); -- 5
SELECT ok(NOT has_column_privilege('authenticated', 'public.chat_messages', 'citations', 'INSERT'), 'citations still not user-writable'); -- 6
SELECT ok((SELECT prosecdef AND provolatile = 'v' AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
  WHERE oid = 'public.append_chat_turn_message_server(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)'::regprocedure),
  'turn function: SECURITY DEFINER, VOLATILE, pinned search_path'); -- 7
SELECT ok(has_function_privilege('sso_control', 'public.append_chat_turn_message_server(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.append_chat_turn_message_server(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.append_chat_turn_message_server(uuid,uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)', 'EXECUTE'),
  'turn function: sso_control only'); -- 8
SELECT ok(to_regprocedure('public.append_chat_message_server(uuid,uuid,uuid,text,text,text,text,jsonb,text,jsonb,boolean)') IS NOT NULL,
  'append_chat_message_server is unchanged (no overload)'); -- 9

-- The user opens turns on their own threads.
SELECT pg_temp.as_user('e6111111-1111-4111-8111-111111111111');
SELECT lives_ok($$INSERT INTO public.chat_messages (organization_id, thread_id, role, content, turn_id) VALUES
  ('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1','user','q','e6d00000-0000-4000-8000-000000000001')$$,
  'owner opens a turn'); -- 10
SELECT throws_ok($$INSERT INTO public.chat_messages (organization_id, thread_id, role, content, turn_id) VALUES
  ('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1','user','q','e6d00000-0000-4000-8000-000000000001')$$,
  '23505', NULL, 'the same turn cannot get a second user message'); -- 11
SELECT lives_ok($$INSERT INTO public.chat_messages (organization_id, thread_id, role, content, turn_id) VALUES
  ('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a3','user','q','e6d00000-0000-4000-8000-000000000001')$$,
  'uniqueness is per thread'); -- 12
SELECT throws_ok($$INSERT INTO public.chat_messages (organization_id, thread_id, role, content, turn_id) VALUES
  ('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1','assistant','forged','e6d00000-0000-4000-8000-000000000001')$$,
  '42501', NULL, 'a user cannot write an assistant row for a turn'); -- 13
SELECT throws_ok($$INSERT INTO public.chat_messages (organization_id, thread_id, role, content, turn_id) VALUES
  ('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a2','user','q','e6d00000-0000-4000-8000-000000000009')$$,
  '42501', NULL, 'no turns in a colleague''s thread'); -- 14
SELECT throws_ok($$SELECT public.append_chat_turn_message_server('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111',
  'e6700000-0000-4000-8000-0000000000a1','e6d00000-0000-4000-8000-000000000001','assistant','x')$$,
  '42501', NULL, 'authenticated cannot call the turn function'); -- 15
SELECT is((SELECT turn_id FROM public.chat_messages WHERE thread_id = 'e6700000-0000-4000-8000-0000000000a1' AND role = 'user'),
  'e6d00000-0000-4000-8000-000000000001'::uuid, 'owner reads the turn id back'); -- 16
RESET role;

-- The server answers the turn.
SELECT is((pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','e6700000-0000-4000-8000-0000000000a1',
  'e6d00000-0000-4000-8000-000000000001', 'assistant', 'stopped'))->>'turn_id', 'e6d00000-0000-4000-8000-000000000001', 'answer stamped with its turn'); -- 17
SELECT lives_ok($$SELECT pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','e6700000-0000-4000-8000-0000000000a1',
  'e6d00000-0000-4000-8000-000000000001')$$, 'a retry adds a second answer to the same turn'); -- 18
SELECT throws_ok($$SELECT pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','e6700000-0000-4000-8000-0000000000a1',
  'e6d00000-0000-4000-8000-0000000000ff')$$, 'P0002', 'TURN_NOT_FOUND', 'no answer for a turn that was never opened'); -- 19
SELECT throws_ok($$SELECT pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','e6700000-0000-4000-8000-0000000000a2',
  'e6d00000-0000-4000-8000-000000000001')$$, 'P0002', 'TURN_NOT_FOUND', 'a turn of another thread cannot be answered here'); -- 20
SELECT throws_ok($$SELECT pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','e6700000-0000-4000-8000-0000000000a1',
  'e6d00000-0000-4000-8000-000000000001')$$, 'P0002', 'NOT_FOUND', 'acting for a non-owner is refused'); -- 21
SELECT throws_ok($$SELECT pg_temp.turn('e6b00000-0000-4000-8000-00000000000b','e6333333-3333-4333-8333-333333333333','e6700000-0000-4000-8000-0000000000a1',
  'e6d00000-0000-4000-8000-000000000001')$$, 'P0002', 'NOT_FOUND', 'cross-tenant answer refused'); -- 22
SELECT throws_ok($$SELECT pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','e6700000-0000-4000-8000-0000000000a1',
  'e6d00000-0000-4000-8000-000000000001', 'user')$$, '22023', NULL, 'the server function never writes user messages'); -- 23
SELECT throws_ok($$SELECT pg_temp.turn('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','e6700000-0000-4000-8000-0000000000a1', NULL)$$,
  '22023', NULL, 'a turn id is required'); -- 24
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE turn_id = 'e6d00000-0000-4000-8000-000000000001' AND thread_id = 'e6700000-0000-4000-8000-0000000000a1'),
  3, 'thread A1 holds one user message and two answers for the turn'); -- 25

-- Tenant B sees nothing of tenant A's turns.
SELECT pg_temp.as_user('e6333333-3333-4333-8333-333333333333');
SELECT is((SELECT count(*)::int FROM public.chat_messages WHERE turn_id = 'e6d00000-0000-4000-8000-000000000001'), 0, 'turn ids are tenant-isolated'); -- 26
RESET role;

SELECT * FROM finish();
ROLLBACK;
