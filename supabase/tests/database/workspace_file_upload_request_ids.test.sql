-- workspace_file_upload_request_ids.test.sql — 20261122100002 (Q-13): idempotent file uploads.
-- One live file per (organization, owner, upload_request_id); keys are per owner (no cross-user or
-- cross-tenant collision or oracle); a failed upload frees its key; the key is not updatable.
BEGIN;
SELECT plan(12);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e8111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_upk_a1@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e8222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_upk_a2@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e8333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_upk_b1@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e8a00000-0000-4000-8000-00000000000a','Keys A','ws-upk-a'), ('e8b00000-0000-4000-8000-00000000000b','Keys B','ws-upk-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','agent'),
 ('e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','agent'),
 ('e8b00000-0000-4000-8000-00000000000b','e8333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('e8700000-0000-4000-8000-0000000000a1','e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','A1 first','it-model'),
 ('e8700000-0000-4000-8000-0000000000a3','e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','A1 second','it-model'),
 ('e8700000-0000-4000-8000-0000000000a2','e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','A2','it-model'),
 ('e8700000-0000-4000-8000-0000000000b1','e8b00000-0000-4000-8000-00000000000b','e8333333-3333-4333-8333-333333333333','B1','it-model');


CREATE FUNCTION pg_temp.as_user(p_sub text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;


SELECT col_type_is('public', 'workspace_files', 'upload_request_id', 'uuid', 'upload_request_id is a uuid'); -- 1
SELECT col_is_null('public', 'workspace_files', 'upload_request_id', 'upload_request_id is nullable (key-less uploads keep NULL)'); -- 2
SELECT ok((SELECT indisunique AND pg_get_expr(indpred, indrelid) LIKE '%status <> ''failed''%' FROM pg_index
  WHERE indexrelid = 'public.workspace_files_upload_request_id_unique'::regclass), 'unique per owner, failed rows excluded'); -- 3
SELECT ok(NOT has_column_privilege('authenticated', 'public.workspace_files', 'upload_request_id', 'UPDATE'), 'upload_request_id is not updatable'); -- 4

SELECT pg_temp.as_user('e8111111-1111-4111-8111-111111111111');
SELECT lives_ok($$INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, upload_request_id) VALUES ('e8a00000-0000-4000-8000-0000000000f1','e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','a.txt','text/plain',3,'e8f00000-0000-4000-8000-000000000001')$$, 'the owner uploads with a key'); -- 5
SELECT throws_ok($$INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, upload_request_id) VALUES (gen_random_uuid(),'e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','a.txt','text/plain',3,'e8f00000-0000-4000-8000-000000000001')$$, '23505', NULL, 'the same key cannot create a second live file'); -- 6
SELECT throws_ok($$UPDATE public.workspace_files SET upload_request_id = gen_random_uuid() WHERE id = 'e8a00000-0000-4000-8000-0000000000f1'$$, '42501', NULL, 'the key cannot be changed'); -- 7
UPDATE public.workspace_files SET status = 'failed' WHERE id = 'e8a00000-0000-4000-8000-0000000000f1';
SELECT lives_ok($$INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, upload_request_id) VALUES (gen_random_uuid(),'e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','a.txt','text/plain',3,'e8f00000-0000-4000-8000-000000000001')$$, 'a failed upload frees its key'); -- 8
RESET role;
SELECT pg_temp.as_user('e8222222-2222-4222-8222-222222222222');
SELECT lives_ok($$INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, upload_request_id) VALUES (gen_random_uuid(),'e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','b.txt','text/plain',3,'e8f00000-0000-4000-8000-000000000001')$$, 'a colleague using the same key gets their own file'); -- 9
SELECT is((SELECT count(*)::int FROM public.workspace_files WHERE upload_request_id = 'e8f00000-0000-4000-8000-000000000001'), 1, 'and sees only that one (no oracle on the owner''s files)'); -- 10
RESET role;
SELECT pg_temp.as_user('e8333333-3333-4333-8333-333333333333');
SELECT lives_ok($$INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, upload_request_id) VALUES (gen_random_uuid(),'e8b00000-0000-4000-8000-00000000000b','e8333333-3333-4333-8333-333333333333','c.txt','text/plain',3,'e8f00000-0000-4000-8000-000000000001')$$, 'another tenant using the same key gets their own file'); -- 11
SELECT is((SELECT count(*)::int FROM public.workspace_files WHERE upload_request_id = 'e8f00000-0000-4000-8000-000000000001'), 1, 'and sees only its own'); -- 12
RESET role;

SELECT * FROM finish();
ROLLBACK;
