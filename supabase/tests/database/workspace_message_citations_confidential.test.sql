-- workspace_message_citations_confidential.test.sql — 20261120200002 (Q-9c, F-2):
-- stored citation snippets are not readable by authenticated. The thread owner
-- reads them only through chat_message_citations, which drops — at read time,
-- in the database — every entry whose document is gone, no longer matches the
-- stored collection/file, or sits in a collection the caller can no longer
-- read. Order and n are preserved; restored access brings the entry back.
BEGIN;
SELECT plan(30);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e6111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_mcc_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e6222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_mcc_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e6333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_mcc_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e6a00000-0000-4000-8000-00000000000a','Snippets A','ws-mcc-a'), ('e6b00000-0000-4000-8000-00000000000b','Snippets B','ws-mcc-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','owner'),
 ('e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','agent'),
 ('e6b00000-0000-4000-8000-00000000000b','e6333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes) VALUES
 ('e6f00000-0000-4000-8000-000000000001','e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','pricing.md','text/markdown',10),
 ('e6f00000-0000-4000-8000-000000000002','e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','notes.md','text/markdown',10),
 ('e6f00000-0000-4000-8000-000000000003','e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','board.md','text/markdown',10);
UPDATE public.workspace_files SET status = 'ready', sha256 = repeat(right(id::text, 1), 64) WHERE organization_id = 'e6a00000-0000-4000-8000-00000000000a';
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility) VALUES
 ('e6c00000-0000-4000-8000-000000000001','e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','Shared pricing','organization'),
 ('e6c00000-0000-4000-8000-000000000002','e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','My notes','private'),
 ('e6c00000-0000-4000-8000-000000000003','e6a00000-0000-4000-8000-00000000000a','e6111111-1111-4111-8111-111111111111','Board only','private');
INSERT INTO public.knowledge_documents (id, organization_id, collection_id, file_id, added_by, title) VALUES
 ('e60d0000-0000-4000-8000-000000000001','e6a00000-0000-4000-8000-00000000000a','e6c00000-0000-4000-8000-000000000001','e6f00000-0000-4000-8000-000000000001','e6111111-1111-4111-8111-111111111111','pricing.md'),
 ('e60d0000-0000-4000-8000-000000000002','e6a00000-0000-4000-8000-00000000000a','e6c00000-0000-4000-8000-000000000002','e6f00000-0000-4000-8000-000000000002','e6222222-2222-4222-8222-222222222222','notes.md'),
 ('e60d0000-0000-4000-8000-000000000003','e6a00000-0000-4000-8000-00000000000a','e6c00000-0000-4000-8000-000000000003','e6f00000-0000-4000-8000-000000000003','e6111111-1111-4111-8111-111111111111','board.md');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('e6700000-0000-4000-8000-0000000000a1','e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','Pricing chat','it-model');
CREATE FUNCTION pg_temp.cit(p_n int, p_doc text, p_col text, p_file text, p_snippet text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('n', p_n, 'documentId', 'e60d0000-0000-4000-8000-00000000000' || p_doc, 'collectionId', 'e6c00000-0000-4000-8000-00000000000' || p_col,
    'fileId', 'e6f00000-0000-4000-8000-00000000000' || p_file, 'title', 'doc ' || p_doc, 'ordinal', 0, 'snippet', p_snippet) $f$;
-- Setup as table owner: one cited answer (5 entries), one user message, one plain answer.
INSERT INTO public.chat_messages (id, organization_id, thread_id, role, content, created_at, citations) VALUES
 ('e65e0000-0000-4000-8000-000000000001','e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1','user','What is the discount?', now() - interval '3 min', '[]'),
 ('e65e0000-0000-4000-8000-000000000002','e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1','assistant','See [1] [2] [3] [4] [5]', now() - interval '2 min',
   jsonb_build_array(pg_temp.cit(1,'1','1','1','SHARED: enterprise discount 40%'), pg_temp.cit(2,'2','2','2','MINE: call notes'),
                     pg_temp.cit(3,'3','3','3','BOARD: acquisition target'), pg_temp.cit(4,'9','1','1','GONE: deleted doc'),
                     pg_temp.cit(5,'1','2','1','MOVED: wrong collection'))),
 ('e65e0000-0000-4000-8000-000000000003','e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1','assistant','Plain', now() - interval '1 min', '[]');
CREATE FUNCTION pg_temp.ns(p_org uuid DEFAULT 'e6a00000-0000-4000-8000-00000000000a', p_ids uuid[] DEFAULT ARRAY['e65e0000-0000-4000-8000-000000000001',
  'e65e0000-0000-4000-8000-000000000002','e65e0000-0000-4000-8000-000000000003']::uuid[]) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(string_agg(message_id::text || ':' || jsonb_path_query_array(citations, '$[*].n')::text, ',' ORDER BY message_id), '<none>')
  FROM public.chat_message_citations(p_org, 'e6700000-0000-4000-8000-0000000000a1', p_ids) $f$;
GRANT EXECUTE ON FUNCTION pg_temp.ns(uuid, uuid[]) TO authenticated;

-- Grants (as postgres).
SELECT ok(NOT has_column_privilege('authenticated','public.chat_messages','citations','SELECT')
  AND NOT has_column_privilege('anon','public.chat_messages','citations','SELECT'), 'no SELECT on citations for authenticated/anon'); -- 1
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['id','thread_id','organization_id','role','content','model_key','mentions','capability_key','status',
  'created_at','knowledge_unavailable']) c WHERE has_column_privilege('authenticated','public.chat_messages',c,'SELECT')), 11, 'every other column stays readable'); -- 2
SELECT ok(NOT has_column_privilege('authenticated','public.chat_messages','citations','INSERT')
  AND NOT has_column_privilege('authenticated','public.chat_messages','knowledge_unavailable','INSERT'), 'no INSERT on citations/knowledge_unavailable'); -- 3
SELECT ok((SELECT prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
  WHERE oid = 'public.chat_message_citations(uuid,uuid,uuid[])'::regprocedure), 'RPC: SECURITY DEFINER, STABLE, pinned search_path'); -- 4
SELECT ok(has_function_privilege('authenticated','public.chat_message_citations(uuid,uuid,uuid[])','EXECUTE')
  AND NOT has_function_privilege('anon','public.chat_message_citations(uuid,uuid,uuid[])','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = 'public.chat_message_citations(uuid,uuid,uuid[])'::regprocedure AND x.grantee = 0),
  'RPC: authenticated only, no anon/PUBLIC'); -- 5

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e6222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok($$SELECT citations FROM public.chat_messages WHERE thread_id = 'e6700000-0000-4000-8000-0000000000a1'$$, '42501', NULL,
  'thread owner cannot SELECT citations directly'); -- 6
SELECT throws_ok($$SELECT * FROM public.chat_messages$$, '42501', NULL, 'SELECT * is denied (select=* in PostgREST)'); -- 7
SELECT throws_ok($$SELECT count(*) FROM public.chat_messages WHERE citations::text LIKE '%BOARD%'$$, '42501', NULL, 'no filtering on citations (no oracle)'); -- 8
SELECT is((SELECT string_agg(role || ':' || content, '|' ORDER BY created_at) FROM public.chat_messages WHERE thread_id = 'e6700000-0000-4000-8000-0000000000a1'),
  'user:What is the discount?|assistant:See [1] [2] [3] [4] [5]|assistant:Plain', 'message text stays readable'); -- 9

-- Read-time filtering.
SELECT is(pg_temp.ns(), 'e65e0000-0000-4000-8000-000000000002:[1, 2]',
  'only readable, still-matching documents: shared + own (board, deleted, mismatched dropped); messages without citations omitted'); -- 10
SELECT is((SELECT citations->0->>'snippet' FROM public.chat_message_citations('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1',
  ARRAY['e65e0000-0000-4000-8000-000000000002']::uuid[])), 'SHARED: enterprise discount 40%', 'allowed entries are returned unchanged'); -- 11
SELECT is((SELECT count(*)::int FROM public.chat_message_citations('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1',
  ARRAY['e65e0000-0000-4000-8000-000000000002']::uuid[]) r, jsonb_array_elements(r.citations) e WHERE e->>'snippet' LIKE 'BOARD%' OR e->>'snippet' LIKE 'GONE%' OR e->>'snippet' LIKE 'MOVED%'),
  0, 'no denied snippet text is returned'); -- 12
SELECT is(pg_temp.ns(p_ids => ARRAY['e65e0000-0000-4000-8000-000000000003']::uuid[]), '<none>', 'only the requested message ids are considered'); -- 13

-- Revoke: the shared collection is made private by its owner.
RESET ROLE;
UPDATE public.knowledge_collections SET visibility = 'private' WHERE id = 'e6c00000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.ns(), 'e65e0000-0000-4000-8000-000000000002:[2]', 'after revocation the shared snippet is gone at the DB level'); -- 14
-- Delete: the member removes their own document.
RESET ROLE;
DELETE FROM public.knowledge_documents WHERE id = 'e60d0000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.ns(), 'e65e0000-0000-4000-8000-000000000002:[]', 'after deletion nothing is left (row returned with [])'); -- 15
-- Restore: access returns, the snapshot entry is returned again.
RESET ROLE;
UPDATE public.knowledge_collections SET visibility = 'organization' WHERE id = 'e6c00000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.ns(), 'e65e0000-0000-4000-8000-000000000002:[1]', 'restored access brings the entry back (same n)'); -- 16
RESET ROLE;
SELECT is((SELECT jsonb_array_length(citations) FROM public.chat_messages WHERE id = 'e65e0000-0000-4000-8000-000000000002'), 5,
  'the stored snapshot itself is unchanged (filtering is read-time)'); -- 17

-- Membership removed: nothing at all.
DELETE FROM public.organization_members WHERE user_id = 'e6222222-2222-4222-8222-222222222222';
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.ns(), '<none>', 'a removed member reads no citations of their old thread'); -- 18
RESET ROLE;
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ('e6a00000-0000-4000-8000-00000000000a','e6222222-2222-4222-8222-222222222222','agent');
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.ns(), 'e65e0000-0000-4000-8000-000000000002:[1]', 're-added member reads them again'); -- 19

-- Other callers.
SELECT is(pg_temp.ns(p_org => 'e6b00000-0000-4000-8000-00000000000b'), '<none>', 'owner with a wrong org id: nothing'); -- 20
SELECT set_config('request.jwt.claims','{"sub":"e6111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is(pg_temp.ns(), '<none>', 'org owner (who can read the documents) still cannot read a member''s thread'); -- 21
SELECT throws_ok($$SELECT citations FROM public.chat_messages$$, '42501', NULL, 'org owner cannot SELECT citations directly either'); -- 22
SELECT set_config('request.jwt.claims','{"sub":"e6333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is(pg_temp.ns(), '<none>', 'other tenant with A''s org id: nothing'); -- 23
SELECT is(pg_temp.ns(p_org => 'e6b00000-0000-4000-8000-00000000000b'), '<none>', 'other tenant with its own org id: nothing'); -- 24
SELECT throws_ok($$SELECT * FROM public.chat_message_citations('e6b00000-0000-4000-8000-00000000000b','e6700000-0000-4000-8000-0000000000a1',
  (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 401)))$$, '22023', 'INVALID_REQUEST', 'more than 400 ids rejected'); -- 25
SELECT throws_ok($$SELECT * FROM public.chat_message_citations('e6b00000-0000-4000-8000-00000000000b','e6700000-0000-4000-8000-0000000000a1', NULL)$$,
  '22023', 'INVALID_REQUEST', 'NULL ids rejected'); -- 26
SELECT throws_ok($$SELECT * FROM public.chat_message_citations('e6a00000-0000-4000-8000-00000000000a', NULL, ARRAY[]::uuid[])$$,
  '42501', 'FORBIDDEN', 'NULL thread: FORBIDDEN'); -- 27
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SELECT throws_ok($$SELECT * FROM public.chat_message_citations('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1', ARRAY[]::uuid[])$$,
  '42501', 'FORBIDDEN', 'no user id: FORBIDDEN'); -- 28
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT * FROM public.chat_message_citations('e6a00000-0000-4000-8000-00000000000a','e6700000-0000-4000-8000-0000000000a1', ARRAY[]::uuid[])$$,
  '42501', NULL, 'anon cannot call the RPC'); -- 29
RESET ROLE;
-- search_chat_threads (SECURITY INVOKER) never needed citations: still works for the owner.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e6222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$SELECT * FROM public.search_chat_threads('e6a00000-0000-4000-8000-00000000000a', 'discount')$$, 'thread search still works'); -- 30
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
