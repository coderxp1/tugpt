-- workspace_chat.test.sql — 20261115000001: private threads, append-only messages,
-- tool-call audit, and the @-picker capability states. Two organizations throughout.
BEGIN;
SELECT plan(30);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e1111111-1111-4111-8111-111111111111','authenticated','authenticated','chat_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e2222222-2222-4222-8222-222222222222','authenticated','authenticated','chat_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e3333333-3333-4333-8333-333333333333','authenticated','authenticated','chat_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('ea000000-0000-4000-8000-00000000000a','Chat A','chat-a'),
 ('eb000000-0000-4000-8000-00000000000b','Chat B','chat-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('ea000000-0000-4000-8000-00000000000a','e1111111-1111-4111-8111-111111111111','owner'),
 ('ea000000-0000-4000-8000-00000000000a','e2222222-2222-4222-8222-222222222222','agent'),
 ('eb000000-0000-4000-8000-00000000000b','e3333333-3333-4333-8333-333333333333','owner');

-- 1-3 lockdown
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('chat_threads','chat_messages','connect_tool_calls') AND c.relrowsecurity AND c.relforcerowsecurity),
  3, 'chat tables have RLS enabled and forced');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['chat_threads','chat_messages','connect_tool_calls']) t,
  unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('anon','public.'||t,p)), 0, 'anon has no privilege on chat tables');
SELECT ok(NOT has_table_privilege('authenticated','public.connect_tool_calls','INSERT')
  AND NOT has_table_privilege('authenticated','public.connect_tool_calls','UPDATE')
  AND NOT has_table_privilege('authenticated','public.connect_tool_calls','DELETE')
  AND NOT has_table_privilege('authenticated','public.chat_messages','UPDATE')
  AND NOT has_table_privilege('authenticated','public.chat_messages','DELETE'), 'audit and messages are append-only for authenticated');

-- member A2 creates a private thread
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key)
  VALUES ('e7000000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-00000000000a','e2222222-2222-4222-8222-222222222222','Plan the week','tugpt-scout')$$, 'member creates own thread');            -- 4
SELECT throws_ok($$INSERT INTO public.chat_threads (organization_id, owner_user_id, model_key)
  VALUES ('eb000000-0000-4000-8000-00000000000b','e2222222-2222-4222-8222-222222222222','tugpt-scout')$$, '42501', NULL, 'cannot create a thread in an organization one is not a member of'); -- 5
SELECT throws_ok($$INSERT INTO public.chat_threads (organization_id, owner_user_id, model_key)
  VALUES ('ea000000-0000-4000-8000-00000000000a','e1111111-1111-4111-8111-111111111111','tugpt-scout')$$, '42501', NULL, 'cannot create a thread owned by someone else'); -- 6
SELECT lives_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content, mentions)
  VALUES ('e7000000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-00000000000a','user','When am I free on Tuesday?','[{"capability":"calendar.find_availability","provider":"google"}]')$$, 'owner appends a message'); -- 7
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content)
  VALUES ('e7000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-00000000000b','user','x')$$, '42501', NULL, 'message cannot be re-homed into another organization'); -- 8
SELECT throws_ok($$UPDATE public.chat_messages SET content='edited'$$, '42501', NULL, 'messages cannot be edited'); -- 9
SELECT throws_ok($$DELETE FROM public.chat_messages$$, '42501', NULL, 'messages cannot be deleted individually'); -- 10
SELECT throws_ok($$UPDATE public.chat_threads SET owner_user_id='e1111111-1111-4111-8111-111111111111'$$, '42501', NULL, 'thread ownership cannot be transferred'); -- 11
SELECT lives_ok($$UPDATE public.chat_threads SET title='Week plan', updated_at=now() WHERE id='e7000000-0000-4000-8000-000000000001'$$, 'owner renames thread'); -- 12

-- audit
SELECT ok(public.record_connect_tool_call('ea000000-0000-4000-8000-00000000000a','e7000000-0000-4000-8000-000000000001','calendar.find_availability','google',NULL,'requires_connection','CONNECT_NO_CONNECTION',3,repeat('a',64)) IS NOT NULL, 'member records a tool call'); -- 13
SELECT is((SELECT actor_user_id FROM public.connect_tool_calls), 'e2222222-2222-4222-8222-222222222222'::uuid, 'actor is fixed to the caller'); -- 14
SELECT throws_ok($$SELECT public.record_connect_tool_call('eb000000-0000-4000-8000-00000000000b',NULL,'calendar.find_availability','google',NULL,'failed',NULL,1,repeat('b',64))$$, '42501', NULL, 'cannot record into another organization'); -- 15
SELECT is((SELECT state FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a') WHERE provider_key='google'), 'not_available', 'google is not available until rollout'); -- 16
SELECT is((SELECT state FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a') WHERE provider_key='microsoft'), 'not_available', 'microsoft is listed but not available'); -- 17

-- org owner A1: cannot read A2's chat, can read A2's audit, cannot post into A2's thread
SELECT set_config('request.jwt.claims','{"sub":"e1111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.chat_threads), 0, 'org owner cannot see a member''s private threads'); -- 18
SELECT is((SELECT count(*)::int FROM public.chat_messages), 0, 'org owner cannot see a member''s messages'); -- 19
SELECT throws_ok($$INSERT INTO public.chat_messages (thread_id, organization_id, role, content)
  VALUES ('e7000000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-00000000000a','assistant','forged')$$, '42501', NULL, 'org owner cannot write into a member''s thread'); -- 20
SELECT is((SELECT count(*)::int FROM public.connect_tool_calls), 1, 'org owner reads the organization''s tool-call audit'); -- 21
SELECT throws_ok($$SELECT public.record_connect_tool_call('ea000000-0000-4000-8000-00000000000a','e7000000-0000-4000-8000-000000000001','calendar.find_availability','google',NULL,'failed',NULL,1,repeat('c',64))$$, '42501', NULL, 'cannot attribute a call to someone else''s thread'); -- 22

-- other tenant B1 sees nothing of A
SELECT set_config('request.jwt.claims','{"sub":"e3333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.chat_threads) + (SELECT count(*)::int FROM public.chat_messages) + (SELECT count(*)::int FROM public.connect_tool_calls), 0, 'other tenant sees no threads, messages or audit'); -- 23
SELECT is((SELECT count(*)::int FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a')), 0, 'other tenant gets no capabilities for A'); -- 24
RESET ROLE;

-- rollout + connections (fixtures as owner)
UPDATE public.integration_providers SET is_available = true WHERE key = 'google';
INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, owner_user_id, external_account_id, status, scopes) VALUES
 ('ec0000a1-0000-4000-8000-000000000001','ea000000-0000-4000-8000-00000000000a','google','user','e1111111-1111-4111-8111-111111111111','g-owner-a','connected',ARRAY['https://www.googleapis.com/auth/calendar.freebusy']);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT state FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a') WHERE provider_key='google'), 'requires_connection', 'another user''s personal connection is not usable'); -- 25
SELECT throws_ok($$SELECT public.record_connect_tool_call('ea000000-0000-4000-8000-00000000000a',NULL,'calendar.find_availability','google','ec0000a1-0000-4000-8000-000000000001','succeeded',NULL,1,repeat('d',64))$$, '42501', NULL, 'cannot record use of another user''s connection'); -- 26
SELECT set_config('request.jwt.claims','{"sub":"e1111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT state || ':' || connection_id::text FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a') WHERE provider_key='google'),
  'connected:ec0000a1-0000-4000-8000-000000000001', 'own connection with the required scope is connected'); -- 27
RESET ROLE;
UPDATE public.connected_accounts SET scopes = '{}' WHERE id = 'ec0000a1-0000-4000-8000-000000000001';
INSERT INTO public.organization_integration_policies (organization_id, allowed_provider_keys) VALUES ('ea000000-0000-4000-8000-00000000000a', ARRAY['microsoft']);
SET LOCAL ROLE authenticated;
SELECT is((SELECT state FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a') WHERE provider_key='google'), 'disabled_by_policy', 'organization policy disables the provider'); -- 28
RESET ROLE;
DELETE FROM public.organization_integration_policies WHERE organization_id = 'ea000000-0000-4000-8000-00000000000a';
SET LOCAL ROLE authenticated;
SELECT is((SELECT state FROM public.list_chat_capabilities('ea000000-0000-4000-8000-00000000000a') WHERE provider_key='google'), 'requires_connection', 'connection without the required scope does not count'); -- 29
RESET ROLE;

-- a removed member loses access to their own threads in that organization
DELETE FROM public.organization_members WHERE organization_id='ea000000-0000-4000-8000-00000000000a' AND user_id='e2222222-2222-4222-8222-222222222222';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.chat_threads), 0, 'removed member can no longer read their threads'); -- 30
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
