-- workspace_document_jobs.test.sql — 20261120100001 + 20261120100002:
-- queued document processing (lease, retry with backoff, dead letter,
-- abandoned leases), embeddings written only by the worker, hybrid search
-- (keyword / semantic / hybrid via RRF) under the caller's permissions,
-- reindex requests and tenant isolation.
BEGIN;
SELECT plan(36);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e8111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_job_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e8222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_job_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e8333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_job_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('e8a00000-0000-4000-8000-00000000000a','Jobs A','ws-jobs-a'), ('e8b00000-0000-4000-8000-00000000000b','Jobs B','ws-jobs-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','owner'),
 ('e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','agent'),
 ('e8b00000-0000-4000-8000-00000000000b','e8333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes) VALUES
 ('e8f00000-0000-4000-8000-000000000001','e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','policy.txt','text/plain',100),
 ('e8f00000-0000-4000-8000-000000000002','e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','bad.pdf','application/pdf',100),
 ('e8f00000-0000-4000-8000-000000000003','e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','slow.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',100);
UPDATE public.workspace_files SET status='ready', sha256=repeat('b',64) WHERE organization_id='e8a00000-0000-4000-8000-00000000000a';
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name) VALUES
 ('e8c00000-0000-4000-8000-000000000001','e8a00000-0000-4000-8000-00000000000a','e8222222-2222-4222-8222-222222222222','Member private');
-- Keep other suites' queued jobs out of this test's claims (rolled back at the end).
UPDATE private.knowledge_document_jobs SET run_after = now() + interval '1 day' WHERE status = 'queued';
CREATE TEMP TABLE claims (document_id UUID, attempt INTEGER, lease_token UUID, media_type TEXT, sha256 TEXT);
GRANT ALL ON claims TO service_role, authenticated;

SELECT ok((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'public.knowledge_chunk_embeddings'::regclass)
  AND NOT has_table_privilege('authenticated','public.knowledge_chunk_embeddings','INSERT')
  AND NOT has_table_privilege('service_role','public.knowledge_chunk_embeddings','INSERT'), 'embeddings: RLS forced, no direct writes'); -- 1
SELECT ok(NOT has_function_privilege('authenticated','public.claim_document_jobs(text,integer,integer)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.complete_document_job(uuid,uuid,text,text[],text,text,text[])','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fail_document_job(uuid,uuid,text,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.extend_document_job_lease(uuid,uuid,integer)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.replace_document_chunks(uuid,uuid,text,text[],text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.request_document_reindex(uuid,uuid)','EXECUTE'), 'worker functions are not callable by users'); -- 2
SELECT ok(NOT has_table_privilege('service_role','private.knowledge_document_jobs','SELECT')
  AND NOT has_table_privilege('authenticated','private.knowledge_document_jobs','SELECT'), 'job table is reachable only through functions'); -- 3

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e8222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok($$INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title, status) VALUES ('e8a00000-0000-4000-8000-00000000000a','e8c00000-0000-4000-8000-000000000001','e8f00000-0000-4000-8000-000000000001','e8222222-2222-4222-8222-222222222222','x','ready')$$,
  '42501', NULL, 'users cannot choose a document status'); -- 4
INSERT INTO public.knowledge_documents (id, organization_id, collection_id, file_id, added_by, title) VALUES
 ('e8d00000-0000-4000-8000-000000000001','e8a00000-0000-4000-8000-00000000000a','e8c00000-0000-4000-8000-000000000001','e8f00000-0000-4000-8000-000000000001','e8222222-2222-4222-8222-222222222222','Policy'),
 ('e8d00000-0000-4000-8000-000000000002','e8a00000-0000-4000-8000-00000000000a','e8c00000-0000-4000-8000-000000000001','e8f00000-0000-4000-8000-000000000002','e8222222-2222-4222-8222-222222222222','Bad'),
 ('e8d00000-0000-4000-8000-000000000003','e8a00000-0000-4000-8000-00000000000a','e8c00000-0000-4000-8000-000000000001','e8f00000-0000-4000-8000-000000000003','e8222222-2222-4222-8222-222222222222','Slow');
SELECT is((SELECT array_agg(status ORDER BY id) FROM public.knowledge_documents WHERE collection_id='e8c00000-0000-4000-8000-000000000001'),
  ARRAY['pending','pending','pending'], 'new documents start pending'); -- 5

RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.knowledge_document_jobs WHERE organization_id='e8a00000-0000-4000-8000-00000000000a' AND status='queued' AND attempts=0), 3, 'adding a document enqueues one job each'); -- 6

SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT * FROM public.claim_document_jobs('bad worker!')$$, '22023', 'INVALID_WORKER', 'worker id validated'); -- 7
INSERT INTO claims SELECT document_id, attempt, lease_token, media_type, sha256 FROM public.claim_document_jobs('pgtap-1', 10, 60);
SELECT is((SELECT count(*)::int FROM claims WHERE attempt = 1), 3, 'claim leases all three due jobs at attempt 1'); -- 8
SELECT is((SELECT media_type || '/' || sha256 FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000001'), 'text/plain/' || repeat('b',64), 'claim returns media type and expected sha256'); -- 9
SELECT is((SELECT count(*)::int FROM public.claim_document_jobs('pgtap-2', 10, 60)), 0, 'leased jobs are not handed out twice'); -- 10
SELECT throws_ok($$SELECT public.complete_document_job('e8d00000-0000-4000-8000-000000000001', gen_random_uuid(), 'ready', ARRAY['x'])$$, '55000', 'LEASE_LOST', 'a stale lease token cannot complete'); -- 11
SELECT throws_ok($$SELECT public.complete_document_job('e8d00000-0000-4000-8000-000000000001', (SELECT lease_token FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000001'), 'ready', ARRAY['a','b'], NULL, 'test-embed', ARRAY['[1,0,0]'])$$,
  '22023', 'EMBEDDINGS_MISMATCH', 'embeddings must match chunks one to one'); -- 12
SELECT ok(public.extend_document_job_lease('e8d00000-0000-4000-8000-000000000001', (SELECT lease_token FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000001'), 600) > now() + interval '590 seconds', 'lease can be extended'); -- 13
SELECT is(public.complete_document_job('e8d00000-0000-4000-8000-000000000001', (SELECT lease_token FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000001'), 'ready',
  ARRAY['Travel expense policy for flights and hotels.','Laptop refresh schedule for engineering.'], NULL, 'test-embed', ARRAY['[1,0,0]','[0,1,0]']), 2, 'worker stores chunks and embeddings'); -- 14
SELECT is(public.fail_document_job('e8d00000-0000-4000-8000-000000000002', (SELECT lease_token FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000002'), 'STORAGE_UNAVAILABLE', true), 'queued', 'retryable failure re-queues'); -- 15

RESET ROLE;
SELECT ok((SELECT status = 'pending' AND error_code = 'STORAGE_UNAVAILABLE' AND next_attempt_at BETWEEN now() + interval '29 seconds' AND now() + interval '31 seconds'
  FROM public.knowledge_documents WHERE id='e8d00000-0000-4000-8000-000000000002'), 'document shows the retry and its 30 s backoff'); -- 16
SELECT ok((SELECT status = 'ready' AND chunk_count = 2 AND embedding_model = 'test-embed' AND error_code IS NULL FROM public.knowledge_documents WHERE id='e8d00000-0000-4000-8000-000000000001')
  AND (SELECT status FROM private.knowledge_document_jobs WHERE document_id='e8d00000-0000-4000-8000-000000000001') = 'done', 'completed document is ready and its job done'); -- 17

SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.claim_document_jobs('pgtap-1', 10, 60)), 0, 'a backed-off job is not due yet'); -- 18
RESET ROLE;
UPDATE private.knowledge_document_jobs SET run_after = now() - interval '1 second', attempts = 4 WHERE document_id='e8d00000-0000-4000-8000-000000000002';
SET LOCAL ROLE service_role;
DELETE FROM claims;
INSERT INTO claims SELECT document_id, attempt, lease_token, media_type, sha256 FROM public.claim_document_jobs('pgtap-1', 10, 60);
SELECT is((SELECT attempt FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000002'), 5, 'due job is claimed again with the next attempt number'); -- 19
SELECT is(public.fail_document_job('e8d00000-0000-4000-8000-000000000002', (SELECT lease_token FROM claims WHERE document_id='e8d00000-0000-4000-8000-000000000002'), 'PDF_ENCRYPTED', true), 'dead', 'last attempt goes to the dead letter state'); -- 20
RESET ROLE;
SELECT ok((SELECT status = 'failed' AND error_code = 'PDF_ENCRYPTED' AND next_attempt_at IS NULL FROM public.knowledge_documents WHERE id='e8d00000-0000-4000-8000-000000000002'), 'dead job marks the document failed with its code'); -- 21
-- Abandoned lease on the last attempt: the next claim turns it into a final failure.
UPDATE private.knowledge_document_jobs SET lease_expires_at = now() - interval '1 second', attempts = max_attempts WHERE document_id='e8d00000-0000-4000-8000-000000000003';
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::int FROM public.claim_document_jobs('pgtap-1', 10, 60)), 0, 'exhausted abandoned lease is not re-leased'); -- 22
RESET ROLE;
SELECT ok((SELECT status = 'failed' AND error_code = 'PROCESSING_ABANDONED' FROM public.knowledge_documents WHERE id='e8d00000-0000-4000-8000-000000000003')
  AND (SELECT status FROM private.knowledge_document_jobs WHERE document_id='e8d00000-0000-4000-8000-000000000003') = 'dead', 'abandoned job is dead and visible to the user'); -- 23

-- Search as the member who owns the collection.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e8222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT array_agg(match ORDER BY rank DESC) FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense')), ARRAY['keyword'], 'without an embedding search is keyword only'); -- 24
SELECT is((SELECT array_agg(match || ':' || ordinal ORDER BY rank DESC, chunk_id) FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','[0,1,0]','test-embed')),
  ARRAY['hybrid:0','semantic:1'], 'RRF: keyword+semantic match ranks first, semantic-only match follows'); -- 25
SELECT ok((SELECT semantic_score > 0.99 FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','[0,1,0]','test-embed') WHERE ordinal = 1), 'semantic score is cosine similarity'); -- 26
SELECT is((SELECT count(*)::int FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','[0,1,0]','other-model')), 1, 'vectors from another model are never compared'); -- 27
SELECT is((SELECT count(*)::int FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','[0,1]','test-embed')), 1, 'vectors of another dimension are never compared'); -- 28
SELECT throws_ok($$SELECT * FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','not a vector','test-embed')$$, '22023', 'INVALID_EMBEDDING', 'malformed query vector rejected'); -- 29
SELECT throws_ok($$SELECT * FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','[0,1,0]',NULL)$$, '22023', 'INVALID_EMBEDDING', 'query vector requires its model'); -- 30

-- Other tenant and the org owner (private collection) see nothing.
SELECT set_config('request.jwt.claims','{"sub":"e8333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','expense','[0,1,0]','test-embed'))
  + (SELECT count(*)::int FROM public.knowledge_chunk_embeddings), 0, 'other tenant: no hits, no embeddings'); -- 31
SELECT set_config('request.jwt.claims','{"sub":"e8111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.search_knowledge_hybrid('e8a00000-0000-4000-8000-00000000000a','laptop','[0,1,0]','test-embed')), 0, 'org owner cannot retrieve a member''s private collection'); -- 32
SELECT throws_ok($$SELECT public.request_document_reindex('e8a00000-0000-4000-8000-00000000000a','e8d00000-0000-4000-8000-000000000002')$$, 'P0002', 'NOT_FOUND', 'org owner cannot reindex it either'); -- 33

SELECT set_config('request.jwt.claims','{"sub":"e8222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$SELECT public.request_document_reindex('e8a00000-0000-4000-8000-00000000000a','e8d00000-0000-4000-8000-000000000002')$$, 'collection writer requests a reindex'); -- 34
RESET ROLE;
SELECT ok((SELECT status = 'queued' AND attempts = 0 AND last_error_code IS NULL FROM private.knowledge_document_jobs WHERE document_id='e8d00000-0000-4000-8000-000000000002')
  AND (SELECT status = 'pending' AND processing_attempts = 0 FROM public.knowledge_documents WHERE id='e8d00000-0000-4000-8000-000000000002')
  AND EXISTS (SELECT 1 FROM public.audit_logs WHERE organization_id='e8a00000-0000-4000-8000-00000000000a' AND action='workspace.document.reindex_requested' AND user_id='e8222222-2222-4222-8222-222222222222'),
  'reindex resets the job and is audited'); -- 35
DELETE FROM public.knowledge_documents WHERE id='e8d00000-0000-4000-8000-000000000001';
SELECT is((SELECT count(*)::int FROM public.knowledge_chunk_embeddings WHERE document_id='e8d00000-0000-4000-8000-000000000001')
  + (SELECT count(*)::int FROM private.knowledge_document_jobs WHERE document_id='e8d00000-0000-4000-8000-000000000001'), 0, 'removing a document removes its embeddings and job'); -- 36

SELECT * FROM finish();
ROLLBACK;
