-- workspace_library.test.sql — 20261119100004: collections, documents, chunk
-- writes, full-text search with permissions checked at retrieval time,
-- conversation links, cross-tenant rejection and audit.
BEGIN;
SELECT plan(32);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f7111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_lib_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f7222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_lib_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f7444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_lib_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f7333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_lib_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('f7a00000-0000-4000-8000-00000000000a','Lib A','ws-lib-a'), ('f7b00000-0000-4000-8000-00000000000b','Lib B','ws-lib-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('f7a00000-0000-4000-8000-00000000000a','f7111111-1111-4111-8111-111111111111','owner'), ('f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222','agent'), ('f7a00000-0000-4000-8000-00000000000a','f7444444-4444-4444-8444-444444444444','viewer'), ('f7b00000-0000-4000-8000-00000000000b','f7333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('f7700000-0000-4000-8000-0000000000a2','f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222','Member','tugpt-scout'), ('f7700000-0000-4000-8000-0000000000a1','f7a00000-0000-4000-8000-00000000000a','f7111111-1111-4111-8111-111111111111','Owner','tugpt-scout');
INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes) VALUES
 ('f7f00000-0000-4000-8000-0000000000a2','f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222','handbook.md','text/markdown',100), ('f7f00000-0000-4000-8000-0000000000a1','f7a00000-0000-4000-8000-00000000000a','f7111111-1111-4111-8111-111111111111','calendar.txt','text/plain',100),
 ('f7f00000-0000-4000-8000-0000000000bb','f7b00000-0000-4000-8000-00000000000b','f7333333-3333-4333-8333-333333333333','b.txt','text/plain',100);
UPDATE public.workspace_files SET status='ready', sha256=repeat('a',64);
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name) VALUES ('f7c00000-0000-4000-8000-0000000000bb','f7b00000-0000-4000-8000-00000000000b','f7333333-3333-4333-8333-333333333333','B private');

SELECT ok((SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c WHERE c.oid IN
  ('public.knowledge_collections'::regclass,'public.knowledge_documents'::regclass,'public.knowledge_chunks'::regclass,'public.chat_thread_collections'::regclass)), 'RLS enabled and forced on all library tables'); -- 1
SELECT ok(NOT has_table_privilege('authenticated','public.knowledge_chunks','INSERT') AND NOT has_table_privilege('authenticated','public.knowledge_chunks','DELETE')
  AND NOT has_table_privilege('authenticated','public.knowledge_documents','UPDATE') AND NOT has_table_privilege('anon','public.knowledge_collections','SELECT'), 'chunks/documents are written only through RPCs'); -- 2

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f7222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name) VALUES ('f7c00000-0000-4000-8000-000000000001','f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222','My research')$$, 'member creates a private collection'); -- 3
SELECT throws_ok($$INSERT INTO public.knowledge_collections (organization_id, owner_user_id, name, visibility) VALUES ('f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222','Org wide','organization')$$, '42501', NULL, 'only owners/admins publish organization collections'); -- 4
SELECT throws_ok($$INSERT INTO public.knowledge_collections (organization_id, owner_user_id, name) VALUES ('f7b00000-0000-4000-8000-00000000000b','f7222222-2222-4222-8222-222222222222','X')$$, '42501', NULL, 'cannot create in another organization'); -- 5
SELECT lives_ok($$INSERT INTO public.knowledge_documents (id, organization_id, collection_id, file_id, added_by, title) VALUES ('f7d00000-0000-4000-8000-000000000001','f7a00000-0000-4000-8000-00000000000a','f7c00000-0000-4000-8000-000000000001','f7f00000-0000-4000-8000-0000000000a2','f7222222-2222-4222-8222-222222222222','Handbook')$$, 'member adds own file'); -- 6
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('f7a00000-0000-4000-8000-00000000000a','f7c00000-0000-4000-8000-000000000001','f7f00000-0000-4000-8000-0000000000a1','f7222222-2222-4222-8222-222222222222','Not mine')$$, '42501', NULL, 'cannot add a private file one cannot read'); -- 7
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('f7a00000-0000-4000-8000-00000000000a','f7c00000-0000-4000-8000-000000000001','f7f00000-0000-4000-8000-0000000000bb','f7222222-2222-4222-8222-222222222222','Other tenant')$$, '42501', NULL, 'cannot add another tenant''s file'); -- 8
SELECT is(public.replace_document_chunks('f7a00000-0000-4000-8000-00000000000a','f7d00000-0000-4000-8000-000000000001','ready',ARRAY['The onboarding handbook explains the expense policy for travel.','Second chunk about laptops.']), 2, 'member indexes own document'); -- 9
SELECT throws_ok($$SELECT public.replace_document_chunks('f7a00000-0000-4000-8000-00000000000a','f7d00000-0000-4000-8000-000000000001','failed',ARRAY['x'],'BAD')$$, '22023', 'CHUNKS_REQUIRE_READY', 'chunks only with ready status'); -- 10
SELECT is((SELECT document_id FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','expense policy')), 'f7d00000-0000-4000-8000-000000000001'::uuid, 'search finds own document'); -- 11
SELECT ok((SELECT snippet !~ '<' AND snippet ~* 'expense' FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','expense')), 'snippets are plain text'); -- 12
SELECT throws_ok($$UPDATE public.knowledge_collections SET visibility='organization' WHERE id='f7c00000-0000-4000-8000-000000000001'$$, '42501', NULL, 'a member cannot publish to the organization'); -- 13
SELECT lives_ok($$INSERT INTO public.chat_thread_collections (thread_id, collection_id, organization_id, linked_by) VALUES ('f7700000-0000-4000-8000-0000000000a2','f7c00000-0000-4000-8000-000000000001','f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222')$$, 'member links collection to own conversation'); -- 14
SELECT throws_ok($$INSERT INTO public.chat_thread_collections (thread_id, collection_id, organization_id, linked_by) VALUES ('f7700000-0000-4000-8000-0000000000a1','f7c00000-0000-4000-8000-000000000001','f7a00000-0000-4000-8000-00000000000a','f7222222-2222-4222-8222-222222222222')$$, '42501', NULL, 'cannot link to someone else''s conversation'); -- 15
SELECT throws_ok($$SELECT * FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a',repeat('x',201))$$, '22023', 'QUERY_TOO_LONG', 'query length bounded'); -- 16

-- org owner A1: cannot see the member's private collection
SELECT set_config('request.jwt.claims','{"sub":"f7111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','expense')), 0, 'private collections are not searchable by the org owner'); -- 17
SELECT throws_ok($$SELECT public.replace_document_chunks('f7a00000-0000-4000-8000-00000000000a','f7d00000-0000-4000-8000-000000000001','ready',ARRAY['owned'])$$, 'P0002', 'NOT_FOUND', 'org owner cannot rewrite a private collection'); -- 18
SELECT throws_ok($$INSERT INTO public.chat_thread_collections (thread_id, collection_id, organization_id, linked_by) VALUES ('f7700000-0000-4000-8000-0000000000a1','f7c00000-0000-4000-8000-000000000001','f7a00000-0000-4000-8000-00000000000a','f7111111-1111-4111-8111-111111111111')$$, '42501', NULL, 'cannot link a collection one cannot read'); -- 19
SELECT lives_ok($$INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility) VALUES ('f7c00000-0000-4000-8000-000000000002','f7a00000-0000-4000-8000-00000000000a','f7111111-1111-4111-8111-111111111111','Company','organization')$$, 'owner publishes an organization collection'); -- 20
INSERT INTO public.knowledge_documents (id, organization_id, collection_id, file_id, added_by, title) VALUES ('f7d00000-0000-4000-8000-000000000002','f7a00000-0000-4000-8000-00000000000a','f7c00000-0000-4000-8000-000000000002','f7f00000-0000-4000-8000-0000000000a1','f7111111-1111-4111-8111-111111111111','Holidays');
SELECT is(public.replace_document_chunks('f7a00000-0000-4000-8000-00000000000a','f7d00000-0000-4000-8000-000000000002','ready',ARRAY['Company holiday calendar for 2027']), 1, 'owner indexes org document'); -- 21

SELECT set_config('request.jwt.claims','{"sub":"f7444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','holiday')), 1, 'viewer can search organization knowledge'); -- 22
SELECT throws_ok($$INSERT INTO public.knowledge_collections (organization_id, owner_user_id, name) VALUES ('f7a00000-0000-4000-8000-00000000000a','f7444444-4444-4444-8444-444444444444','V')$$, '42501', NULL, 'viewers cannot create collections'); -- 23

SELECT set_config('request.jwt.claims','{"sub":"f7222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','holiday')), 1, 'member can search organization knowledge'); -- 24
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES ('f7a00000-0000-4000-8000-00000000000a','f7c00000-0000-4000-8000-000000000002','f7f00000-0000-4000-8000-0000000000a2','f7222222-2222-4222-8222-222222222222','Mine')$$, '42501', NULL, 'members cannot write organization collections'); -- 25

-- owner B1: cross tenant
SELECT set_config('request.jwt.claims','{"sub":"f7333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','holiday')), 0, 'other tenant cannot search A'); -- 26
SELECT is((SELECT count(*)::int FROM public.knowledge_collections WHERE organization_id='f7a00000-0000-4000-8000-00000000000a') + (SELECT count(*)::int FROM public.knowledge_chunks WHERE organization_id='f7a00000-0000-4000-8000-00000000000a'), 0, 'other tenant sees no A collections or chunks'); -- 27
SELECT throws_ok($$SELECT public.replace_document_chunks('f7a00000-0000-4000-8000-00000000000a','f7d00000-0000-4000-8000-000000000002','ready',ARRAY['x'])$$, 'P0002', 'NOT_FOUND', 'other tenant cannot write A documents'); -- 28

-- permission is checked at retrieval time: making a collection private hides it immediately
SELECT set_config('request.jwt.claims','{"sub":"f7111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
UPDATE public.knowledge_collections SET visibility='private' WHERE id='f7c00000-0000-4000-8000-000000000002';
SELECT set_config('request.jwt.claims','{"sub":"f7222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge('f7a00000-0000-4000-8000-00000000000a','holiday')), 0, 'unpublished collection disappears from search at once'); -- 29
DELETE FROM public.workspace_files WHERE id='f7f00000-0000-4000-8000-0000000000a2';
SELECT is((SELECT count(*)::int FROM public.knowledge_chunks WHERE document_id='f7d00000-0000-4000-8000-000000000001'), 0, 'deleting the file removes its document and chunks'); -- 30
SELECT lives_ok($$DELETE FROM public.knowledge_collections WHERE id='f7c00000-0000-4000-8000-000000000001'$$, 'member deletes own collection'); -- 31

RESET ROLE;
SELECT is((SELECT array_agg(DISTINCT action ORDER BY action) FROM public.audit_logs WHERE organization_id='f7a00000-0000-4000-8000-00000000000a' AND action LIKE 'workspace.%'
  AND action NOT LIKE 'workspace.file.%'),
  ARRAY['workspace.collection.created','workspace.collection.deleted','workspace.collection.visibility_changed','workspace.document.added',
        'workspace.document.removed','workspace.thread_collection.linked','workspace.thread_collection.unlinked'], 'library operations are audited'); -- 32

SELECT * FROM finish();
ROLLBACK;
