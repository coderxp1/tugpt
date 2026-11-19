-- workspace_conversations.test.sql — 20261119100001: folders, placement,
-- search, archive/restore/delete and the audit trail. Two organizations.
BEGIN;
SELECT plan(26);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f4111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_conv_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f4222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_conv_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f4333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_conv_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('f4a00000-0000-4000-8000-00000000000a','Conv A','ws-conv-a'),
 ('f4b00000-0000-4000-8000-00000000000b','Conv B','ws-conv-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('f4a00000-0000-4000-8000-00000000000a','f4111111-1111-4111-8111-111111111111','owner'),
 ('f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222','agent'),
 ('f4b00000-0000-4000-8000-00000000000b','f4333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('f4700000-0000-4000-8000-000000000001','f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222','Quarterly budget','tugpt-scout'),
 ('f4700000-0000-4000-8000-000000000002','f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222','Team offsite','tugpt-scout'),
 ('f4700000-0000-4000-8000-000000000003','f4b00000-0000-4000-8000-00000000000b','f4333333-3333-4333-8333-333333333333','Quarterly budget B','tugpt-scout');
INSERT INTO public.chat_messages (thread_id, organization_id, role, content) VALUES
 ('f4700000-0000-4000-8000-000000000002','f4a00000-0000-4000-8000-00000000000a','user','Can you help with the invoice reconciliation?'),
 ('f4700000-0000-4000-8000-000000000003','f4b00000-0000-4000-8000-00000000000b','user','invoice reconciliation for B');
INSERT INTO public.chat_folders (id, organization_id, owner_user_id, name) VALUES
 ('f4f00000-0000-4000-8000-0000000000b1','f4b00000-0000-4000-8000-00000000000b','f4333333-3333-4333-8333-333333333333','B folder'),
 ('f4f00000-0000-4000-8000-0000000000a1','f4a00000-0000-4000-8000-00000000000a','f4111111-1111-4111-8111-111111111111','Owner folder');

SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='chat_folders' AND c.relrowsecurity AND c.relforcerowsecurity), 1, 'chat_folders has RLS enabled and forced'); -- 1
SELECT ok(NOT has_table_privilege('anon','public.chat_folders','SELECT') AND NOT has_function_privilege('anon','public.search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz)','EXECUTE'), 'anon has no access'); -- 2
SELECT ok(NOT has_function_privilege('authenticated','private.workspace_audit(uuid,text,text,jsonb)','EXECUTE'), 'API roles cannot write audit rows directly'); -- 3

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f4222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.chat_folders (id, organization_id, owner_user_id, name)
  VALUES ('f4f00000-0000-4000-8000-0000000000a2','f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222','Finance')$$, 'member creates own folder'); -- 4
SELECT throws_ok($$INSERT INTO public.chat_folders (organization_id, owner_user_id, name)
  VALUES ('f4b00000-0000-4000-8000-00000000000b','f4222222-2222-4222-8222-222222222222','X')$$, '42501', NULL, 'cannot create a folder in another organization'); -- 5
SELECT throws_ok($$INSERT INTO public.chat_folders (organization_id, owner_user_id, name)
  VALUES ('f4a00000-0000-4000-8000-00000000000a','f4111111-1111-4111-8111-111111111111','X')$$, '42501', NULL, 'cannot create a folder for someone else'); -- 6
SELECT throws_ok($$INSERT INTO public.chat_folders (organization_id, owner_user_id, name)
  VALUES ('f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222',' finance ')$$, '23505', NULL, 'folder names are unique per owner, case-insensitive'); -- 7
SELECT is((SELECT count(*)::int FROM public.chat_folders), 1, 'member sees only own folders'); -- 8
SELECT lives_ok($$UPDATE public.chat_threads SET folder_id='f4f00000-0000-4000-8000-0000000000a2' WHERE id='f4700000-0000-4000-8000-000000000001'$$, 'member files own thread'); -- 9
SELECT throws_ok($$UPDATE public.chat_threads SET folder_id='f4f00000-0000-4000-8000-0000000000b1' WHERE id='f4700000-0000-4000-8000-000000000001'$$, '23503', NULL, 'cannot file into another tenant''s folder'); -- 10
SELECT throws_ok($$UPDATE public.chat_threads SET folder_id='f4f00000-0000-4000-8000-0000000000a1' WHERE id='f4700000-0000-4000-8000-000000000001'$$, '23503', NULL, 'cannot file into another user''s folder'); -- 11
SELECT is((SELECT match_source FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a','budget')), 'title', 'title search'); -- 12
SELECT is((SELECT id FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a','reconciliation') WHERE match_source='message'),
  'f4700000-0000-4000-8000-000000000002'::uuid, 'message text search'); -- 13
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f4b00000-0000-4000-8000-00000000000b','budget')), 0, 'search in a foreign organization returns nothing'); -- 14
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a',NULL,false,'f4f00000-0000-4000-8000-0000000000a2')), 1, 'folder filter'); -- 15
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a',NULL,false,NULL,true)), 1, 'unfiled filter'); -- 16
UPDATE public.chat_threads SET archived_at=now() WHERE id='f4700000-0000-4000-8000-000000000001';
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a','budget')), 0, 'archived threads leave the default list'); -- 17
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a','budget',true)), 1, 'archived list shows them'); -- 18
SELECT throws_ok($$SELECT * FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a',repeat('x',201))$$, '22023', 'QUERY_TOO_LONG', 'query length is bounded'); -- 19

-- org owner A1: no visibility or control over a member's conversations
SELECT set_config('request.jwt.claims','{"sub":"f4111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_chat_threads('f4a00000-0000-4000-8000-00000000000a','budget',true)), 0, 'org owner cannot search a member''s threads'); -- 20
UPDATE public.chat_threads SET title='hijack' WHERE id='f4700000-0000-4000-8000-000000000002';
DELETE FROM public.chat_threads WHERE id='f4700000-0000-4000-8000-000000000002';
DELETE FROM public.chat_folders WHERE id='f4f00000-0000-4000-8000-0000000000a2';
-- owner B1: cross-tenant
SELECT set_config('request.jwt.claims','{"sub":"f4333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
DELETE FROM public.chat_threads WHERE organization_id='f4a00000-0000-4000-8000-00000000000a';
SELECT is((SELECT count(*)::int FROM public.chat_folders WHERE organization_id='f4a00000-0000-4000-8000-00000000000a'), 0, 'other tenant sees no folders'); -- 21

SELECT set_config('request.jwt.claims','{"sub":"f4222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT title FROM public.chat_threads WHERE id='f4700000-0000-4000-8000-000000000002'), 'Team offsite', 'other users could neither rename nor delete the thread'); -- 22
DELETE FROM public.chat_folders WHERE id='f4f00000-0000-4000-8000-0000000000a2';
SELECT ok((SELECT folder_id IS NULL FROM public.chat_threads WHERE id='f4700000-0000-4000-8000-000000000001'), 'deleting a folder un-files its threads, keeps them'); -- 23
SELECT lives_ok($$DELETE FROM public.chat_threads WHERE id='f4700000-0000-4000-8000-000000000002'$$, 'owner deletes own thread'); -- 24

RESET ROLE;
SELECT is((SELECT array_agg(action ORDER BY action) FROM (SELECT DISTINCT action FROM public.audit_logs
  WHERE organization_id='f4a00000-0000-4000-8000-00000000000a' AND action LIKE 'workspace.%') a),
  ARRAY['workspace.conversation.archived','workspace.conversation.deleted','workspace.conversation.moved',
        'workspace.folder.created','workspace.folder.deleted'], 'sensitive conversation operations are audited'); -- 25
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id='f4a00000-0000-4000-8000-00000000000a'
  AND action LIKE 'workspace.%' AND user_id IS DISTINCT FROM 'f4222222-2222-4222-8222-222222222222'::uuid
  AND action <> 'workspace.folder.created'), 0, 'audit actor is the caller'); -- 26

SELECT * FROM finish();
ROLLBACK;
