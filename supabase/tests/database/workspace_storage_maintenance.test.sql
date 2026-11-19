-- workspace_storage_maintenance.test.sql — 20261120100005: blob deletion
-- outbox, stale upload expiry, orphan lookups and the organization purge
-- (grace period, scope, idempotence, audit), all service_role only.
BEGIN;
SELECT plan(24);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','eb111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_mt_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','eb333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_mt_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('eba00000-0000-4000-8000-00000000000a','Maint A','ws-mt-a'), ('ebb00000-0000-4000-8000-00000000000b','Maint B','ws-mt-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','owner'),
 ('ebb00000-0000-4000-8000-00000000000b','eb333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.workspace_files (id, organization_id, owner_user_id, filename, media_type, size_bytes, created_at) VALUES
 ('ebf00000-0000-4000-8000-000000000001','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','a.txt','text/plain',10, now()),
 ('ebf00000-0000-4000-8000-000000000002','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','stale.txt','text/plain',10, now() - interval '2 hours'),
 ('ebf00000-0000-4000-8000-000000000003','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','fresh.txt','text/plain',10, now() - interval '5 minutes'),
 ('ebf00000-0000-4000-8000-0000000000b1','ebb00000-0000-4000-8000-00000000000b','eb333333-3333-4333-8333-333333333333','b.txt','text/plain',10, now());
UPDATE public.workspace_files SET status='ready', sha256=repeat('c',64) WHERE id IN ('ebf00000-0000-4000-8000-000000000001','ebf00000-0000-4000-8000-0000000000b1');
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name) VALUES
 ('ebc00000-0000-4000-8000-00000000000a','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','A'),
 ('ebc00000-0000-4000-8000-00000000000b','ebb00000-0000-4000-8000-00000000000b','eb333333-3333-4333-8333-333333333333','B');
INSERT INTO public.knowledge_documents (organization_id, collection_id, file_id, added_by, title) VALUES
 ('eba00000-0000-4000-8000-00000000000a','ebc00000-0000-4000-8000-00000000000a','ebf00000-0000-4000-8000-000000000001','eb111111-1111-4111-8111-111111111111','A doc');
INSERT INTO public.custom_agents (organization_id, owner_user_id, name) VALUES
 ('eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','A agent'),
 ('ebb00000-0000-4000-8000-00000000000b','eb333333-3333-4333-8333-333333333333','B agent');
INSERT INTO public.chat_folders (organization_id, owner_user_id, name) VALUES ('eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','F');
-- Keep other suites' outbox rows out of this test's claims (rolled back).
UPDATE private.workspace_blob_deletions SET next_attempt_at = now() + interval '1 day';

SELECT ok(NOT has_function_privilege('authenticated','public.claim_blob_deletions(integer)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.complete_blob_deletions(bigint[],bigint[])','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.workspace_files_existing(uuid[])','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.expire_stale_uploads(integer)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.list_purgeable_organizations(integer,integer)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.purge_organization_workspace(uuid,integer)','EXECUTE')
  AND NOT has_function_privilege('anon','public.purge_organization_workspace(uuid,integer)','EXECUTE'), 'maintenance functions are service_role only'); -- 1
SELECT ok(NOT has_table_privilege('service_role','private.workspace_blob_deletions','SELECT') AND NOT has_table_privilege('authenticated','private.workspace_org_purges','SELECT'), 'outbox and purge log are private'); -- 2

-- A user deleting their file queues the blob.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"eb111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
DELETE FROM public.workspace_files WHERE id = 'ebf00000-0000-4000-8000-000000000003';
RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.workspace_blob_deletions WHERE file_id = 'ebf00000-0000-4000-8000-000000000003' AND reason = 'file_deleted'), 1, 'deleting a file queues its blob'); -- 3

SET LOCAL ROLE service_role;
SELECT is(public.expire_stale_uploads(60), 1, 'only uploads older than the grace period are expired'); -- 4
SELECT is(public.expire_stale_uploads(1), 0, 'grace period has a 15 minute floor'); -- 5
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.workspace_files WHERE id = 'ebf00000-0000-4000-8000-000000000002')
  AND EXISTS (SELECT 1 FROM private.workspace_blob_deletions WHERE file_id = 'ebf00000-0000-4000-8000-000000000002'), 'expired upload row removed and its blob queued'); -- 6

SET LOCAL ROLE service_role;
CREATE TEMP TABLE got (id BIGINT, organization_id UUID, file_id UUID, attempts INTEGER);
RESET ROLE; GRANT ALL ON got TO service_role; SET LOCAL ROLE service_role;
INSERT INTO got SELECT * FROM public.claim_blob_deletions(10);
SELECT is((SELECT count(*)::int FROM got), 2, 'claim returns the due deletions'); -- 7
SELECT is((SELECT count(*)::int FROM public.claim_blob_deletions(10)), 0, 'claimed deletions are leased'); -- 8
SELECT is(public.complete_blob_deletions(ARRAY(SELECT id FROM got WHERE file_id = 'ebf00000-0000-4000-8000-000000000003'), ARRAY(SELECT id FROM got WHERE file_id = 'ebf00000-0000-4000-8000-000000000002')), 1, 'completed deletions are removed'); -- 9
RESET ROLE;
SELECT ok((SELECT claimed_until IS NULL AND attempts = 1 AND next_attempt_at > now() + interval '1 minute' FROM private.workspace_blob_deletions WHERE file_id = 'ebf00000-0000-4000-8000-000000000002'), 'failed deletion backs off and stays for retry'); -- 10

SET LOCAL ROLE service_role;
SELECT is((SELECT array_agg(x ORDER BY x) FROM public.workspace_files_existing(ARRAY['ebf00000-0000-4000-8000-000000000001','ebf00000-0000-4000-8000-000000000003','ebf00000-0000-4000-8000-0000000000b1']::uuid[]) x),
  ARRAY['ebf00000-0000-4000-8000-000000000001','ebf00000-0000-4000-8000-0000000000b1']::uuid[], 'orphan check reports which files still exist'); -- 11

-- Purge guards.
SELECT throws_ok($$SELECT public.purge_organization_workspace('eba00000-0000-4000-8000-00000000000a', 30)$$, '55000', 'ORGANIZATION_NOT_PURGEABLE', 'live organizations are never purged'); -- 12
RESET ROLE;
UPDATE public.organizations SET deleted_at = now() - interval '5 days' WHERE id = 'eba00000-0000-4000-8000-00000000000a';
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.purge_organization_workspace('eba00000-0000-4000-8000-00000000000a', 30)$$, '55000', 'ORGANIZATION_NOT_PURGEABLE', 'organizations inside the grace period are not purged'); -- 13
SELECT throws_ok($$SELECT public.purge_organization_workspace('eba00000-0000-4000-8000-00000000000a', 1)$$, '55000', 'ORGANIZATION_NOT_PURGEABLE', 'grace period cannot go below 7 days'); -- 14
RESET ROLE;
UPDATE public.organizations SET deleted_at = now() - interval '40 days' WHERE id = 'eba00000-0000-4000-8000-00000000000a';
SET LOCAL ROLE service_role;
SELECT ok('eba00000-0000-4000-8000-00000000000a' IN (SELECT organization_id FROM public.list_purgeable_organizations(30, 100)), 'deleted organization past the grace period is listed'); -- 15
SELECT is(public.purge_organization_workspace('eba00000-0000-4000-8000-00000000000a', 30),
  '{"custom_agents":1,"knowledge_collections":1,"workspace_files":1,"approval_requests":0,"chat_folders":1,"rate_limit_counters":0}'::jsonb, 'purge reports what it deleted'); -- 16
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.workspace_files WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a')
  + (SELECT count(*)::int FROM public.knowledge_collections WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a')
  + (SELECT count(*)::int FROM public.knowledge_documents WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a')
  + (SELECT count(*)::int FROM public.custom_agents WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a')
  + (SELECT count(*)::int FROM public.chat_folders WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a'), 0, 'workspace data of the purged organization is gone'); -- 17
SELECT is((SELECT count(*)::int FROM public.workspace_files WHERE organization_id = 'ebb00000-0000-4000-8000-00000000000b')
  + (SELECT count(*)::int FROM public.knowledge_collections WHERE organization_id = 'ebb00000-0000-4000-8000-00000000000b')
  + (SELECT count(*)::int FROM public.custom_agents WHERE organization_id = 'ebb00000-0000-4000-8000-00000000000b'), 3, 'other organizations are untouched'); -- 18
SELECT is((SELECT array_agg(reason || ':' || COALESCE(file_id::text, 'prefix')) FROM private.workspace_blob_deletions WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a' AND created_at >= now() AND file_id IS DISTINCT FROM 'ebf00000-0000-4000-8000-000000000002'),
  ARRAY['org_purged:prefix'], 'purge queues one prefix deletion instead of one per file'); -- 19
SELECT ok(EXISTS (SELECT 1 FROM public.organizations WHERE id = 'eba00000-0000-4000-8000-00000000000a'), 'the organization row itself is left to its owner process'); -- 20
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a' AND action = 'workspace.organization.purged'), 1, 'purge is audited once'); -- 21
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a' AND action IN ('workspace.agent.deleted','workspace.collection.deleted','workspace.document.removed')), 0, 'no per-row audit noise during the purge'); -- 22
SET LOCAL ROLE service_role;
SELECT is(public.purge_organization_workspace('eba00000-0000-4000-8000-00000000000a', 30)->>'workspace_files', '1', 'a second purge is a no-op returning the stored counts'); -- 23
SELECT ok('eba00000-0000-4000-8000-00000000000a' NOT IN (SELECT organization_id FROM public.list_purgeable_organizations(30, 100)), 'purged organization is no longer listed'); -- 24

SELECT * FROM finish();
ROLLBACK;
