-- workspace_files.test.sql — 20261119100003: file metadata ownership,
-- visibility, forward-only status, delete rights, attachments, audit.
BEGIN;
SELECT plan(27);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f6111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_file_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f6222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_file_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f6444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_file_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f6333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_file_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('f6a00000-0000-4000-8000-00000000000a','Files A','ws-files-a'),
 ('f6b00000-0000-4000-8000-00000000000b','Files B','ws-files-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('f6a00000-0000-4000-8000-00000000000a','f6111111-1111-4111-8111-111111111111','owner'),
 ('f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','agent'),
 ('f6a00000-0000-4000-8000-00000000000a','f6444444-4444-4444-8444-444444444444','viewer'),
 ('f6b00000-0000-4000-8000-00000000000b','f6333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('f6700000-0000-4000-8000-0000000000a2','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','Member','tugpt-scout'),
 ('f6700000-0000-4000-8000-0000000000a1','f6a00000-0000-4000-8000-00000000000a','f6111111-1111-4111-8111-111111111111','Owner','tugpt-scout'),
 ('f6700000-0000-4000-8000-0000000000b1','f6b00000-0000-4000-8000-00000000000b','f6333333-3333-4333-8333-333333333333','B','tugpt-scout');

SELECT ok((SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c
  WHERE c.oid IN ('public.workspace_files'::regclass,'public.chat_thread_attachments'::regclass)), 'RLS enabled and forced'); -- 1
SELECT ok(NOT has_table_privilege('anon','public.workspace_files','SELECT') AND NOT has_table_privilege('anon','public.chat_thread_attachments','SELECT')
  AND NOT has_column_privilege('authenticated','public.workspace_files','owner_user_id','UPDATE')
  AND NOT has_column_privilege('authenticated','public.workspace_files','organization_id','UPDATE')
  AND NOT has_column_privilege('authenticated','public.workspace_files','visibility','UPDATE'), 'owner, tenant and visibility are not updatable'); -- 2
SELECT ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workspace_files'
  AND column_name ~ '(key|path|url|bucket)'), 'no storage key, path or URL is stored'); -- 3

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f6222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes)
  VALUES ('f6f00000-0000-4000-8000-000000000001','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','notes.txt','text/plain',12)$$, 'member registers an upload'); -- 4
SELECT throws_ok($$INSERT INTO public.workspace_files (organization_id, owner_user_id, filename, media_type, size_bytes, status, sha256)
  VALUES ('f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','x.txt','text/plain',1,'ready',repeat('a',64))$$, '42501', NULL, 'cannot insert a file as already ready'); -- 5
SELECT throws_ok($$INSERT INTO public.workspace_files (organization_id, owner_user_id, filename, media_type, size_bytes)
  VALUES ('f6b00000-0000-4000-8000-00000000000b','f6222222-2222-4222-8222-222222222222','x.txt','text/plain',1)$$, '42501', NULL, 'cannot upload into another organization'); -- 6
SELECT throws_ok($$INSERT INTO public.workspace_files (organization_id, owner_user_id, filename, media_type, size_bytes)
  VALUES ('f6a00000-0000-4000-8000-00000000000a','f6111111-1111-4111-8111-111111111111','x.txt','text/plain',1)$$, '42501', NULL, 'cannot upload as someone else'); -- 7
SELECT throws_ok($$INSERT INTO public.workspace_files (organization_id, owner_user_id, filename, media_type, size_bytes)
  VALUES ('f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','../etc/passwd','text/plain',1)$$, '23514', NULL, 'path separators are rejected in filenames'); -- 8
SELECT throws_ok($$INSERT INTO public.workspace_files (organization_id, owner_user_id, filename, media_type, size_bytes)
  VALUES ('f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','big.bin','application/pdf',52428801)$$, '23514', NULL, 'size ceiling enforced in the database'); -- 9
SELECT lives_ok($$UPDATE public.workspace_files SET status='ready', sha256=repeat('a',64) WHERE id='f6f00000-0000-4000-8000-000000000001'$$, 'uploader finalises'); -- 10
SELECT throws_ok($$UPDATE public.workspace_files SET status='uploading' WHERE id='f6f00000-0000-4000-8000-000000000001'$$, '55000', 'INVALID_STATUS_TRANSITION', 'status only moves forward'); -- 11
SELECT throws_ok($$UPDATE public.workspace_files SET sha256=repeat('b',64) WHERE id='f6f00000-0000-4000-8000-000000000001'$$, '55000', 'FILE_CONTENT_IMMUTABLE', 'a ready file''s content is immutable'); -- 12
INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, visibility)
  VALUES ('f6f00000-0000-4000-8000-000000000002','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','policy.md','text/markdown',20,'organization'),
         ('f6f00000-0000-4000-8000-000000000003','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222','pending.md','text/markdown',20,'organization');
UPDATE public.workspace_files SET status='ready', sha256=repeat('c',64) WHERE id='f6f00000-0000-4000-8000-000000000002';
SELECT lives_ok($$INSERT INTO public.chat_thread_attachments (thread_id, file_id, organization_id, attached_by)
  VALUES ('f6700000-0000-4000-8000-0000000000a2','f6f00000-0000-4000-8000-000000000001','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222')$$, 'member attaches own file to own thread'); -- 13
SELECT throws_ok($$INSERT INTO public.chat_thread_attachments (thread_id, file_id, organization_id, attached_by)
  VALUES ('f6700000-0000-4000-8000-0000000000a1','f6f00000-0000-4000-8000-000000000001','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222')$$, '42501', NULL, 'cannot attach to someone else''s thread'); -- 14
SELECT throws_ok($$INSERT INTO public.chat_thread_attachments (thread_id, file_id, organization_id, attached_by)
  VALUES ('f6700000-0000-4000-8000-0000000000a2','f6f00000-0000-4000-8000-000000000003','f6a00000-0000-4000-8000-00000000000a','f6222222-2222-4222-8222-222222222222')$$, '42501', NULL, 'cannot attach a file that is not ready'); -- 15

-- viewer: read-only
SELECT set_config('request.jwt.claims','{"sub":"f6444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT throws_ok($$INSERT INTO public.workspace_files (organization_id, owner_user_id, filename, media_type, size_bytes)
  VALUES ('f6a00000-0000-4000-8000-00000000000a','f6444444-4444-4444-8444-444444444444','v.txt','text/plain',1)$$, '42501', NULL, 'viewers cannot upload'); -- 16
SELECT is((SELECT array_agg(filename) FROM public.workspace_files), ARRAY['policy.md'], 'viewer sees only ready organization files'); -- 17

-- org owner A1
SELECT set_config('request.jwt.claims','{"sub":"f6111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.workspace_files WHERE id='f6f00000-0000-4000-8000-000000000001'), 0, 'org owner cannot read a member''s private file'); -- 18
SELECT throws_ok($$INSERT INTO public.chat_thread_attachments (thread_id, file_id, organization_id, attached_by)
  VALUES ('f6700000-0000-4000-8000-0000000000a1','f6f00000-0000-4000-8000-000000000001','f6a00000-0000-4000-8000-00000000000a','f6111111-1111-4111-8111-111111111111')$$, '42501', NULL, 'cannot attach a private file one cannot read'); -- 19
SELECT lives_ok($$INSERT INTO public.chat_thread_attachments (thread_id, file_id, organization_id, attached_by)
  VALUES ('f6700000-0000-4000-8000-0000000000a1','f6f00000-0000-4000-8000-000000000002','f6a00000-0000-4000-8000-00000000000a','f6111111-1111-4111-8111-111111111111')$$, 'organization file can be attached by another member'); -- 20
DELETE FROM public.workspace_files WHERE id='f6f00000-0000-4000-8000-000000000001';
SELECT is((SELECT count(*)::int FROM public.chat_thread_attachments), 1, 'org owner sees only attachments on own threads'); -- 21

-- owner B1: cross tenant
SELECT set_config('request.jwt.claims','{"sub":"f6333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.workspace_files), 0, 'another tenant sees no files'); -- 22
SELECT throws_ok($$INSERT INTO public.chat_thread_attachments (thread_id, file_id, organization_id, attached_by)
  VALUES ('f6700000-0000-4000-8000-0000000000b1','f6f00000-0000-4000-8000-000000000002','f6b00000-0000-4000-8000-00000000000b','f6333333-3333-4333-8333-333333333333')$$, '42501', NULL, 'a file cannot be attached across tenants (RLS first; the composite FK also forbids it)'); -- 23
DELETE FROM public.workspace_files WHERE organization_id='f6a00000-0000-4000-8000-00000000000a';

SELECT set_config('request.jwt.claims','{"sub":"f6111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT lives_ok($$DELETE FROM public.workspace_files WHERE id='f6f00000-0000-4000-8000-000000000002'$$, 'owner/admin can delete an organization file'); -- 24
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.workspace_files WHERE id IN ('f6f00000-0000-4000-8000-000000000001','f6f00000-0000-4000-8000-000000000003')), 2,
  'private file survived the org owner, and cross-tenant deletes changed nothing'); -- 25
SELECT is((SELECT count(*)::int FROM public.chat_thread_attachments WHERE file_id='f6f00000-0000-4000-8000-000000000002'), 0, 'deleting a file removes its attachments'); -- 26
SELECT is((SELECT array_agg(DISTINCT action ORDER BY action) FROM public.audit_logs WHERE organization_id='f6a00000-0000-4000-8000-00000000000a' AND action LIKE 'workspace.%'),
  ARRAY['workspace.attachment.added','workspace.attachment.removed','workspace.file.deleted','workspace.file.uploaded'], 'file operations are audited'); -- 27

SELECT * FROM finish();
ROLLBACK;
