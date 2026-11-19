-- workspace_document_dedupe.test.sql — 20261120100006: one document per
-- content per collection (Q-8 retries), content hash owned by the database,
-- no extra processing jobs for refused duplicates, isolation per collection
-- and tenant, and the in-request chunk writer still closed to users.
BEGIN;
SELECT plan(16);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','ed111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_dedupe_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ed222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_dedupe_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ed333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_dedupe_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('eda00000-0000-4000-8000-00000000000a','Dedupe A','ws-dedupe-a'), ('edb00000-0000-4000-8000-00000000000b','Dedupe B','ws-dedupe-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('eda00000-0000-4000-8000-00000000000a','ed111111-1111-4111-8111-111111111111','owner'),
 ('eda00000-0000-4000-8000-00000000000a','ed222222-2222-4222-8222-222222222222','agent'),
 ('edb00000-0000-4000-8000-00000000000b','ed333333-3333-4333-8333-333333333333','owner');
-- f1 and f2: same bytes uploaded twice (the retry case); f3: other content; fb: tenant B, same bytes as f1.
INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes) VALUES
 ('edf00000-0000-4000-8000-000000000001','eda00000-0000-4000-8000-00000000000a','ed222222-2222-4222-8222-222222222222','plan.md','text/markdown',10),
 ('edf00000-0000-4000-8000-000000000002','eda00000-0000-4000-8000-00000000000a','ed222222-2222-4222-8222-222222222222','plan.md','text/markdown',10),
 ('edf00000-0000-4000-8000-000000000003','eda00000-0000-4000-8000-00000000000a','ed222222-2222-4222-8222-222222222222','other.md','text/markdown',10),
 ('edf00000-0000-4000-8000-0000000000b1','edb00000-0000-4000-8000-00000000000b','ed333333-3333-4333-8333-333333333333','plan.md','text/markdown',10);
UPDATE public.workspace_files SET status='ready', sha256=repeat('e',64) WHERE id IN ('edf00000-0000-4000-8000-000000000001','edf00000-0000-4000-8000-000000000002','edf00000-0000-4000-8000-0000000000b1');
UPDATE public.workspace_files SET status='ready', sha256=repeat('f',64) WHERE id = 'edf00000-0000-4000-8000-000000000003';
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name) VALUES
 ('edc00000-0000-4000-8000-000000000001','eda00000-0000-4000-8000-00000000000a','ed222222-2222-4222-8222-222222222222','Research'),
 ('edc00000-0000-4000-8000-000000000002','eda00000-0000-4000-8000-00000000000a','ed222222-2222-4222-8222-222222222222','Second'),
 ('edc00000-0000-4000-8000-0000000000b1','edb00000-0000-4000-8000-00000000000b','ed333333-3333-4333-8333-333333333333','B research');

SELECT has_column('public','knowledge_documents','content_sha256','content hash column exists'); -- 1
SELECT ok((SELECT indisunique AND indpred IS NOT NULL FROM pg_index WHERE indexrelid = 'public.knowledge_documents_collection_content'::regclass),
  'partial unique index on (collection, content)'); -- 2
SELECT ok(NOT has_column_privilege('authenticated','public.knowledge_documents','content_sha256','INSERT')
  AND NOT has_column_privilege('authenticated','public.knowledge_documents','content_sha256','UPDATE')
  AND NOT has_function_privilege('authenticated','private.knowledge_documents_content_hash()','EXECUTE'), 'users cannot write the content hash'); -- 3
SELECT ok(NOT has_function_privilege('authenticated','public.replace_document_chunks(uuid,uuid,text,text[],text)','EXECUTE'),
  'in-request chunk writer stays closed to users (indexing belongs to the worker)'); -- 4

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"ed222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title, content_sha256) VALUES ('eda00000-0000-4000-8000-00000000000a','edc00000-0000-4000-8000-000000000001','edf00000-0000-4000-8000-000000000001','ed222222-2222-4222-8222-222222222222','x',repeat('0',64))$$,
  '42501', NULL, 'clients cannot supply a content hash'); -- 5
SELECT lives_ok($$INSERT INTO public.knowledge_documents (id, organization_id, collection_id, file_id, added_by, title) VALUES ('edd00000-0000-4000-8000-000000000001','eda00000-0000-4000-8000-00000000000a','edc00000-0000-4000-8000-000000000001','edf00000-0000-4000-8000-000000000001','ed222222-2222-4222-8222-222222222222','Plan')$$,
  'first add succeeds'); -- 6
SELECT is((SELECT content_sha256 FROM public.knowledge_documents WHERE id='edd00000-0000-4000-8000-000000000001'), repeat('e',64), 'hash copied from the file'); -- 7
SELECT is((SELECT status FROM public.knowledge_documents WHERE id='edd00000-0000-4000-8000-000000000001'), 'pending', 'new document is pending, not ready'); -- 8
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('eda00000-0000-4000-8000-00000000000a','edc00000-0000-4000-8000-000000000001','edf00000-0000-4000-8000-000000000001','ed222222-2222-4222-8222-222222222222','Plan again')$$,
  '23505', NULL, 'retry with the same file id is refused'); -- 9
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('eda00000-0000-4000-8000-00000000000a','edc00000-0000-4000-8000-000000000001','edf00000-0000-4000-8000-000000000002','ed222222-2222-4222-8222-222222222222','Plan re-uploaded')$$,
  '23505', NULL, 're-upload of the same bytes (new file id) is refused in the same collection'); -- 10
SELECT lives_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('eda00000-0000-4000-8000-00000000000a','edc00000-0000-4000-8000-000000000001','edf00000-0000-4000-8000-000000000003','ed222222-2222-4222-8222-222222222222','Other')$$,
  'different content in the same collection is fine'); -- 11
SELECT lives_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('eda00000-0000-4000-8000-00000000000a','edc00000-0000-4000-8000-000000000002','edf00000-0000-4000-8000-000000000002','ed222222-2222-4222-8222-222222222222','Plan elsewhere')$$,
  'same content in another collection is fine'); -- 12
SELECT is((SELECT count(*)::int FROM public.knowledge_documents WHERE organization_id='eda00000-0000-4000-8000-00000000000a'), 3, 'exactly three documents, no duplicates'); -- 13

SELECT set_config('request.jwt.claims','{"sub":"ed333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('edb00000-0000-4000-8000-00000000000b','edc00000-0000-4000-8000-0000000000b1','edf00000-0000-4000-8000-0000000000b1','ed333333-3333-4333-8333-333333333333','B plan')$$,
  'another tenant adding the same bytes is independent'); -- 14
SELECT is((SELECT count(*)::int FROM public.knowledge_documents WHERE organization_id='eda00000-0000-4000-8000-00000000000a'), 0, 'tenant B still sees nothing of tenant A'); -- 15

RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.knowledge_document_jobs WHERE organization_id IN ('eda00000-0000-4000-8000-00000000000a','edb00000-0000-4000-8000-00000000000b')), 4,
  'refused duplicates enqueue no processing jobs'); -- 16

SELECT * FROM finish();
ROLLBACK;
