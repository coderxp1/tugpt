-- P2 source only; NOT RUN. Requires approved disposable baseline + RDB-1/2/3.
BEGIN;
SET LOCAL search_path=public,extensions,pg_catalog;
SELECT no_plan();
INSERT INTO auth.users(id,email,email_confirmed_at,role,aud,raw_user_meta_data,raw_app_meta_data)
VALUES ('11111111-1111-1111-1111-111111111111','m01-owner@example.invalid',now(),'authenticated','authenticated','{}','{}'),
('22222222-2222-2222-2222-222222222222','m01-other@example.invalid',now(),'authenticated','authenticated','{}','{}') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.profiles(id,email) VALUES ('11111111-1111-1111-1111-111111111111','m01-owner@example.invalid'),('22222222-2222-2222-2222-222222222222','m01-other@example.invalid') ON CONFLICT(id) DO NOTHING;
INSERT INTO sso.identity_bindings(canonical_sub,dashboard_user_id,canonical_issuer)
VALUES ('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','https://rbiumegrwtavmljxbknp.supabase.co/auth/v1') ON CONFLICT(canonical_sub) DO NOTHING;
INSERT INTO public.organizations(id,name,slug,locale) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Synthetic A','m01-synthetic-a','en'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Synthetic B','m01-synthetic-b','es') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.organization_members(organization_id,user_id,role) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','owner'),('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222','owner') ON CONFLICT(organization_id,user_id) DO NOTHING;
INSERT INTO sso.sessions(hash,subject,auth_session,issued_at,expires_at,canonical_email,email_verified_at)
VALUES (repeat('a',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',clock_timestamp(),clock_timestamp()+interval '10 minutes','m01-owner@example.invalid',clock_timestamp());
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+30)::text,true);

SELECT throws_ok($q$INSERT INTO sso.identity_bindings(canonical_sub,dashboard_user_id,canonical_issuer) VALUES ('55555555-5555-5555-5555-555555555555','22222222-2222-2222-2222-222222222222','https://rbiumegrwtavmljxbknp.supabase.co/auth/v1')$q$,'23514',NULL,'different UUID identity binding prohibited');
SELECT throws_ok($q$INSERT INTO sso.identity_bindings(canonical_sub,dashboard_user_id,canonical_issuer) VALUES ('66666666-6666-6666-6666-666666666666','66666666-6666-6666-6666-666666666666','https://rbiumegrwtavmljxbknp.supabase.co/auth/v1')$q$,'23503',NULL,'binding requires applicable auth.users FK');
CREATE TEMP TABLE invariant_before AS SELECT (SELECT count(*) FROM auth.users) users,(SELECT count(*) FROM public.organization_members) memberships,(SELECT count(*) FROM sso.identity_bindings) bindings;
SELECT is(sso.load_session(repeat('a',64))->>'subject','11111111-1111-1111-1111-111111111111','session subject is canonical UUID');
SELECT is(sso.require_actor('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false),'11111111-1111-1111-1111-111111111111'::uuid,'eligible organization resolved');
SELECT throws_ok($q$SELECT sso.require_actor('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',false)$q$,'42501',NULL,'forged foreign organization denied');
SELECT is((SELECT count(*) FROM auth.users),(SELECT users FROM invariant_before),'session reads do not create Auth accounts');
SELECT is((SELECT count(*) FROM public.organization_members),(SELECT memberships FROM invariant_before),'session reads do not change memberships');
SELECT is((SELECT count(*) FROM sso.identity_bindings),(SELECT bindings FROM invariant_before),'session reads do not auto-link identities');
-- A removable synthetic non-owner membership, not orgA's protected final owner.
INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','agent');
SELECT is(sso.require_actor('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',false),'11111111-1111-1111-1111-111111111111'::uuid,'new explicit test membership is current');
DELETE FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111';
SELECT throws_ok($q$SELECT sso.require_actor('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',false)$q$,'42501',NULL,'removed membership denied on next operation');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.organizations WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),0,'foreign organization cannot be read through RLS');
SELECT throws_ok($q$INSERT INTO public.knowledge_entries(organization_id,question,answer) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Cross tenant question','Forbidden answer')$q$,'42501',NULL,'cross-tenant knowledge write denied');
RESET ROLE;
SELECT throws_ok($q$INSERT INTO sso.identity_bindings(canonical_sub,dashboard_user_id,canonical_issuer) VALUES('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','https://wrong.example/auth/v1')$q$,'23514',NULL,'conflicting issuer binding denied');
DELETE FROM sso.identity_bindings WHERE canonical_sub='11111111-1111-1111-1111-111111111111';
SELECT throws_ok($q$SELECT sso.pre_request()$q$,'28000',NULL,'removed binding denies existing bridge assertion');
-- Tenant cookie/header parsing and full selection/cache discard are tested in
-- F11/F20/T29/T30/H16; SQL claims alone do not establish HTTP gateway validation.

-- BEGIN P2-DB-01 tenant isolation, independent database checks.
RESET ROLE;
INSERT INTO sso.identity_bindings(canonical_sub,dashboard_user_id,canonical_issuer) VALUES('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','https://rbiumegrwtavmljxbknp.supabase.co/auth/v1');
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
-- P2-DB-01 inert synthetic business fixtures; no credentials or queue messages.
INSERT INTO public.business_profiles(id,organization_id,display_name) VALUES('b0000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','P2-DB-01 synthetic reception');
INSERT INTO public.whatsapp_connections(id,organization_id,business_profile_id,phone_number,provider_phone_number_id,status) VALUES('c0000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','b0000000-db01-4000-8000-000000000001','+15550000001','db01-synthetic-1','disconnected');
INSERT INTO public.webhook_events(id,organization_id,whatsapp_connection_id,provider_event_key,event_kind,payload_sha256) VALUES('e0000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-db01-4000-8000-000000000001','db01-event-1','message',repeat('0',64));
INSERT INTO public.conversations(id,organization_id,whatsapp_connection_id,contact_phone,status) VALUES('c1000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','c0000000-db01-4000-8000-000000000001','+15550000011','open');
INSERT INTO public.messages(id,conversation_id,organization_id,webhook_event_id,direction,body,body_source) VALUES('a0000000-db01-4000-8000-000000000001','c1000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','e0000000-db01-4000-8000-000000000001','inbound','P2-DB-01 synthetic question','customer');
INSERT INTO public.ai_drafts(id,organization_id,business_profile_id,conversation_id,source_message_id,status) VALUES('d0000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','b0000000-db01-4000-8000-000000000001','c1000000-db01-4000-8000-000000000001','a0000000-db01-4000-8000-000000000001','approved');
INSERT INTO public.ai_draft_revisions(id,organization_id,draft_id,version,body,created_by_type) VALUES('a1000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001',1,'P2-DB-01 synthetic answer','system');
UPDATE public.ai_drafts SET current_revision_id='a1000000-db01-4000-8000-000000000001' WHERE id='d0000000-db01-4000-8000-000000000001';
INSERT INTO public.outbound_message_deliveries(id,organization_id,draft_id,conversation_id,whatsapp_connection_id,recipient_phone,body,status,attempts,provider_message_id,delivered_at,read_at) VALUES('d1000000-db01-4000-8000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001','c1000000-db01-4000-8000-000000000001','c0000000-db01-4000-8000-000000000001','+15550000011','P2-DB-01 synthetic answer','sent',2,'synthetic-db01-1','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z');
INSERT INTO public.business_profiles(id,organization_id,display_name) VALUES('b0000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','P2-DB-01 synthetic reception');
INSERT INTO public.whatsapp_connections(id,organization_id,business_profile_id,phone_number,provider_phone_number_id,status) VALUES('c0000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','b0000000-db01-4000-8000-000000000002','+15550000002','db01-synthetic-2','disconnected');
INSERT INTO public.webhook_events(id,organization_id,whatsapp_connection_id,provider_event_key,event_kind,payload_sha256) VALUES('e0000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-db01-4000-8000-000000000002','db01-event-2','message',repeat('0',64));
INSERT INTO public.conversations(id,organization_id,whatsapp_connection_id,contact_phone,status) VALUES('c1000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','c0000000-db01-4000-8000-000000000002','+15550000012','open');
INSERT INTO public.messages(id,conversation_id,organization_id,webhook_event_id,direction,body,body_source) VALUES('a0000000-db01-4000-8000-000000000002','c1000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','e0000000-db01-4000-8000-000000000002','inbound','P2-DB-01 synthetic question','customer');
INSERT INTO public.ai_drafts(id,organization_id,business_profile_id,conversation_id,source_message_id,status) VALUES('d0000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','b0000000-db01-4000-8000-000000000002','c1000000-db01-4000-8000-000000000002','a0000000-db01-4000-8000-000000000002','approved');
INSERT INTO public.ai_draft_revisions(id,organization_id,draft_id,version,body,created_by_type) VALUES('a1000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','d0000000-db01-4000-8000-000000000002',1,'P2-DB-01 synthetic answer','system');
UPDATE public.ai_drafts SET current_revision_id='a1000000-db01-4000-8000-000000000002' WHERE id='d0000000-db01-4000-8000-000000000002';
INSERT INTO public.outbound_message_deliveries(id,organization_id,draft_id,conversation_id,whatsapp_connection_id,recipient_phone,body,status,attempts,provider_message_id,delivered_at,read_at) VALUES('d1000000-db01-4000-8000-000000000002','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','d0000000-db01-4000-8000-000000000002','c1000000-db01-4000-8000-000000000002','c0000000-db01-4000-8000-000000000002','+15550000012','P2-DB-01 synthetic answer','sent',2,'synthetic-db01-2','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z');
UPDATE public.feature_flags SET is_enabled=true WHERE key='ai_draft_generation' AND (organization_id IS NULL OR organization_id IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
INSERT INTO public.feature_flags(organization_id,key,is_enabled) SELECT NULL,'ai_draft_generation',true WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE organization_id IS NOT DISTINCT FROM NULL AND key='ai_draft_generation');
INSERT INTO public.feature_flags(organization_id,key,is_enabled) SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'ai_draft_generation',true WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE organization_id IS NOT DISTINCT FROM 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid AND key='ai_draft_generation');
INSERT INTO public.feature_flags(organization_id,key,is_enabled) SELECT 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,'ai_draft_generation',true WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE organization_id IS NOT DISTINCT FROM 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid AND key='ai_draft_generation');
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','d0000000-db01-4000-8000-000000000002')$q$,'42501',NULL,'DB01_single_foreign_org_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',ARRAY['d0000000-db01-4000-8000-000000000002'::uuid])$q$,'42501',NULL,'DB01_bulk_foreign_org_denied');
SELECT is((SELECT count(*)::integer FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000002')),0,'DB01_single_foreign_same_zero_rows');
SELECT is((SELECT count(*)::integer FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000')),0,'DB01_single_missing_same_zero_rows');
SELECT is((SELECT array_agg(draft_id ORDER BY draft_id) FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid,'d0000000-db01-4000-8000-000000000002'::uuid,'d0000000-db01-4000-8000-000000000001'::uuid,'00000000-0000-0000-0000-000000000000'::uuid])),ARRAY['d0000000-db01-4000-8000-000000000001'::uuid],'DB01_bulk_mixed_tenants_no_foreign_or_duplicate_rows');
RESET ROLE;
INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','agent');
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::integer FROM public.sso_get_outbound_delivery_for_draft('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','d0000000-db01-4000-8000-000000000002')),1,'DB01_explicit_current_membership_permits_read');
RESET ROLE;
DELETE FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111';
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','d0000000-db01-4000-8000-000000000002')$q$,'42501',NULL,'DB01_single_removed_membership_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',ARRAY['d0000000-db01-4000-8000-000000000002'::uuid])$q$,'42501',NULL,'DB01_bulk_removed_membership_denied');
RESET ROLE;
DELETE FROM sso.identity_bindings WHERE canonical_sub='11111111-1111-1111-1111-111111111111';
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_unmapped_identity_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_unmapped_identity_denied');
RESET ROLE;
-- END P2-DB-01

SELECT * FROM finish();
ROLLBACK;
