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

SELECT throws_ok($q$SELECT public.create_organization_with_owner('Denied','denied-owner','22222222-2222-2222-2222-222222222222')$q$,'42501',NULL,'owner cannot be supplied as another user');
SELECT throws_ok($q$SELECT public.create_organization_with_owner('Invalid','INVALID','11111111-1111-1111-1111-111111111111')$q$,'22023',NULL,'organization slug validation retained');
SELECT lives_ok($q$SELECT public.create_organization_with_owner('Explicit synthetic action','explicit-p2-action','11111111-1111-1111-1111-111111111111')$q$,'explicit caller-owned organization action');
SELECT is((SELECT role::text FROM public.organization_members WHERE organization_id=(SELECT id FROM public.organizations WHERE slug='explicit-p2-action') AND user_id='11111111-1111-1111-1111-111111111111'),'owner','owner membership is caller-bound');
UPDATE sso.sessions SET email_verified_at=clock_timestamp()-interval '61 seconds' WHERE hash=repeat('a',64);
SELECT throws_ok($q$SELECT public.accept_invitation('not-a-real-token')$q$,'P3D10',NULL,'stale bridge email fails before revealing invite state');
UPDATE sso.sessions SET email_verified_at=clock_timestamp(),canonical_email=NULL WHERE hash=repeat('a',64);
SELECT throws_ok($q$SELECT public.accept_invitation('not-a-real-token')$q$,'P3D10',NULL,'missing bridge email fails closed');
SELECT set_config('request.jwt.claims',jsonb_build_object('sub','11111111-1111-1111-1111-111111111111','role','authenticated')::text,true);
SELECT throws_ok($q$SELECT public.accept_invitation('not-a-real-token')$q$,'P3D01',NULL,'confirmed legacy identity still reaches token validation');
UPDATE auth.users SET email_confirmed_at=NULL WHERE id='11111111-1111-1111-1111-111111111111';
SELECT throws_ok($q$SELECT public.accept_invitation('not-a-real-token')$q$,'P3D10',NULL,'legacy unverified identity denied');

-- Full lifecycle under bridge claims; setup writes are explicit synthetic fixtures.
UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id='11111111-1111-1111-1111-111111111111';
UPDATE sso.sessions SET canonical_email='m01-owner@example.invalid',email_verified_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes' WHERE hash=repeat('a',64);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub','11111111-1111-1111-1111-111111111111','role','authenticated','iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+30)::text,true);
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-other@example.invalid','agent',private.hash_invitation_token('bridge-wrong'),'22222222-2222-2222-2222-222222222222',clock_timestamp()-interval '1 hour');
SELECT throws_ok($q$SELECT public.accept_invitation('bridge-wrong')$q$,'P3D06',NULL,'bridge: wrong recipient precedes expired-state disclosure');
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','agent',private.hash_invitation_token('bridge-expired'),'22222222-2222-2222-2222-222222222222',clock_timestamp()-interval '1 hour');
SELECT throws_ok($q$SELECT public.accept_invitation('bridge-expired')$q$,'P3D05',NULL,'bridge: expired invitation denied');
INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','agent') ON CONFLICT(organization_id,user_id) DO UPDATE SET role='agent';
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','owner',private.hash_invitation_token('bridge-existing'),'22222222-2222-2222-2222-222222222222',clock_timestamp()+interval '1 hour');
SELECT is(public.accept_invitation('bridge-existing')->>'role','agent','bridge: existing role cannot be escalated by invitation');
SELECT is((SELECT role::text FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111'),'agent','bridge: stored role unchanged');
SELECT throws_ok($q$SELECT public.accept_invitation('bridge-existing')$q$,'P3D04',NULL,'bridge: consumed invitation cannot be replayed');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_logs WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111' AND action='invitation.accept' AND details->>'membership_created'='false'),'bridge: existing-role accept has actor-bound audit');
DELETE FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111';
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','agent',private.hash_invitation_token('bridge-explicit'),'22222222-2222-2222-2222-222222222222',clock_timestamp()+interval '1 hour');
SELECT is(public.accept_invitation('bridge-explicit')->>'membership_created','true','bridge: explicit accept creates exactly requested membership');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_logs WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111' AND action='invitation.accept' AND details->>'membership_created'='true'),'bridge: created membership has actor-bound audit');
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','agent',private.hash_invitation_token('bridge-issuer'),'22222222-2222-2222-2222-222222222222',clock_timestamp()+interval '1 hour');
UPDATE public.organization_invitations SET invited_by='11111111-1111-1111-1111-111111111111' WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND status='pending';
SELECT throws_ok($q$SELECT public.accept_invitation('bridge-issuer')$q$,'P3D04',NULL,'bridge: current inviter without owner/admin authority denied');
DELETE FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111';
SELECT throws_ok($q$SELECT public.create_organization_with_owner('Forbidden owner','forbidden-bridge','22222222-2222-2222-2222-222222222222')$q$,'42501',NULL,'bridge: organization owner cannot be another identity');

-- Full lifecycle under legacy claims; setup writes are explicit synthetic fixtures.
UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id='11111111-1111-1111-1111-111111111111';
UPDATE sso.sessions SET canonical_email='m01-owner@example.invalid',email_verified_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes' WHERE hash=repeat('a',64);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub','11111111-1111-1111-1111-111111111111','role','authenticated')::text,true);
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-other@example.invalid','agent',private.hash_invitation_token('legacy-wrong'),'22222222-2222-2222-2222-222222222222',clock_timestamp()-interval '1 hour');
SELECT throws_ok($q$SELECT public.accept_invitation('legacy-wrong')$q$,'P3D06',NULL,'legacy: wrong recipient precedes expired-state disclosure');
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','agent',private.hash_invitation_token('legacy-expired'),'22222222-2222-2222-2222-222222222222',clock_timestamp()-interval '1 hour');
SELECT throws_ok($q$SELECT public.accept_invitation('legacy-expired')$q$,'P3D05',NULL,'legacy: expired invitation denied');
INSERT INTO public.organization_members(organization_id,user_id,role) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','agent') ON CONFLICT(organization_id,user_id) DO UPDATE SET role='agent';
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','owner',private.hash_invitation_token('legacy-existing'),'22222222-2222-2222-2222-222222222222',clock_timestamp()+interval '1 hour');
SELECT is(public.accept_invitation('legacy-existing')->>'role','agent','legacy: existing role cannot be escalated by invitation');
SELECT is((SELECT role::text FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111'),'agent','legacy: stored role unchanged');
SELECT throws_ok($q$SELECT public.accept_invitation('legacy-existing')$q$,'P3D04',NULL,'legacy: consumed invitation cannot be replayed');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_logs WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111' AND action='invitation.accept' AND details->>'membership_created'='false'),'legacy: existing-role accept has actor-bound audit');
DELETE FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111';
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','agent',private.hash_invitation_token('legacy-explicit'),'22222222-2222-2222-2222-222222222222',clock_timestamp()+interval '1 hour');
SELECT is(public.accept_invitation('legacy-explicit')->>'membership_created','true','legacy: explicit accept creates exactly requested membership');
SELECT ok(EXISTS(SELECT 1 FROM public.audit_logs WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111' AND action='invitation.accept' AND details->>'membership_created'='true'),'legacy: created membership has actor-bound audit');
DELETE FROM public.organization_invitations WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','m01-owner@example.invalid','agent',private.hash_invitation_token('legacy-issuer'),'22222222-2222-2222-2222-222222222222',clock_timestamp()+interval '1 hour');
UPDATE public.organization_invitations SET invited_by='11111111-1111-1111-1111-111111111111' WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND status='pending';
SELECT throws_ok($q$SELECT public.accept_invitation('legacy-issuer')$q$,'P3D04',NULL,'legacy: current inviter without owner/admin authority denied');
DELETE FROM public.organization_members WHERE organization_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND user_id='11111111-1111-1111-1111-111111111111';
SELECT throws_ok($q$SELECT public.create_organization_with_owner('Forbidden owner','forbidden-legacy','22222222-2222-2222-2222-222222222222')$q$,'42501',NULL,'legacy: organization owner cannot be another identity');
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$INSERT INTO public.audit_logs(organization_id,user_id,action,resource,details) VALUES('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','forged','invitation','{}')$q$,'42501',NULL,'direct authenticated audit write remains denied');
RESET ROLE;
-- Real post-wait invitation evidence/session/expiry checks are exercised by H17.

-- BEGIN P2-DB-01 business contract, authenticated execution.
RESET ROLE;
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
SELECT is((SELECT count(*)::integer FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')),1,'DB01_single_eligible_row');
SELECT is((SELECT jsonb_build_array(id,organization_id,draft_id,status,provider_message_id,attempts,error_code,updated_at IS NOT NULL,delivered_at,read_at) FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')),jsonb_build_array('d1000000-db01-4000-8000-000000000001'::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'d0000000-db01-4000-8000-000000000001'::uuid,'sent'::text,'synthetic-db01-1'::text,2,NULL,true,'2026-01-01T00:00:00Z'::timestamptz,'2026-01-01T00:01:00Z'::timestamptz),'DB01_single_all_ten_response_columns');
SELECT is((SELECT count(*)::integer FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])),1,'DB01_bulk_eligible_row');
SELECT is((SELECT jsonb_build_array(id,organization_id,draft_id,status,provider_message_id,attempts,error_code,updated_at IS NOT NULL,delivered_at,read_at) FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])),jsonb_build_array('d1000000-db01-4000-8000-000000000001'::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'d0000000-db01-4000-8000-000000000001'::uuid,'sent'::text,'synthetic-db01-1'::text,2,NULL,true,'2026-01-01T00:00:00Z'::timestamptz,'2026-01-01T00:01:00Z'::timestamptz),'DB01_bulk_all_ten_response_columns');
SELECT is((SELECT count(*)::integer FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','{}'::uuid[])),0,'DB01_bulk_empty_and_duplicate_safe');
SELECT is((SELECT count(*)::integer FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',array_fill('d0000000-db01-4000-8000-000000000001'::uuid,ARRAY[100]))),1,'DB01_bulk_100_and_duplicate_safe');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NULL::uuid[])$q$,'22023',NULL,'DB01_bulk_reject_null');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',array_fill('d0000000-db01-4000-8000-000000000001'::uuid,ARRAY[101]))$q$,'22023',NULL,'DB01_bulk_reject_101');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY[NULL::uuid])$q$,'22023',NULL,'DB01_bulk_reject_null_element');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY[ARRAY['d0000000-db01-4000-8000-000000000001'::uuid]])$q$,'22023',NULL,'DB01_bulk_reject_multidimensional');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',array_fill('d0000000-db01-4000-8000-000000000001'::uuid,ARRAY[1],ARRAY[0]))$q$,'22023',NULL,'DB01_bulk_reject_lower_bound');
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NULL)$q$,'22023',NULL,'DB01_single_reject_null');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
UPDATE public.feature_flags SET is_enabled=false WHERE organization_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND key='ai_draft_generation';
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'42501',NULL,'DB01_single_feature_disabled_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'42501',NULL,'DB01_bulk_feature_disabled_denied');
RESET ROLE;
UPDATE public.feature_flags SET is_enabled=true WHERE organization_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND key='ai_draft_generation';
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
UPDATE public.feature_flags SET is_enabled=false WHERE organization_id IS NULL AND key='ai_draft_generation';
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'42501',NULL,'DB01_single_global_feature_disabled_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'42501',NULL,'DB01_bulk_global_feature_disabled_denied');
RESET ROLE;
UPDATE public.feature_flags SET is_enabled=true WHERE organization_id IS NULL AND key='ai_draft_generation';
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
UPDATE sso.sessions SET revoked_at=clock_timestamp() WHERE hash=repeat('a',64);
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_session_revoked_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_session_revoked_denied');
RESET ROLE;
UPDATE sso.sessions SET revoked_at=NULL WHERE hash=repeat('a',64);
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
UPDATE sso.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE hash=repeat('a',64);
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_session_expired_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_session_expired_denied');
RESET ROLE;
UPDATE sso.sessions SET expires_at=clock_timestamp()+interval '10 minutes' WHERE hash=repeat('a',64);
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
SELECT set_config('request.jwt.claims',jsonb_set(current_setting('request.jwt.claims')::jsonb,'{dash_session}',to_jsonb(repeat('f',64)))::text,true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_session_missing_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_session_missing_denied');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);

SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
SELECT set_config('request.jwt.claims',jsonb_set(current_setting('request.jwt.claims')::jsonb,'{exp}',to_jsonb(floor(extract(epoch from clock_timestamp()))-1))::text,true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_assertion_expired_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_assertion_expired_denied');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);

SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
SELECT set_config('request.jwt.claims',jsonb_set(current_setting('request.jwt.claims')::jsonb,'{iss}',to_jsonb('https://wrong.example/auth/v1'::text))::text,true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_non_bridge_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_non_bridge_denied');
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);

SELECT set_config('request.jwt.claims',jsonb_build_object('iss','urn:tugpt:dashboard:bridge','aud','tugpt-dashboard-db','role','authenticated','sub','11111111-1111-1111-1111-111111111111','session_id','33333333-3333-3333-3333-333333333333','dash_session',repeat('a',64),'iat',floor(extract(epoch from clock_timestamp())),'exp',floor(extract(epoch from clock_timestamp()))+60)::text,true);
INSERT INTO sso.revoked_auth_sessions(subject,auth_session) VALUES('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333');
SET LOCAL ROLE authenticated;
SELECT throws_ok($q$SELECT * FROM public.sso_get_outbound_delivery_for_draft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d0000000-db01-4000-8000-000000000001')$q$,'28000',NULL,'DB01_single_family_revoked_denied');
SELECT throws_ok($q$SELECT * FROM public.sso_list_outbound_deliveries_for_drafts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',ARRAY['d0000000-db01-4000-8000-000000000001'::uuid])$q$,'28000',NULL,'DB01_bulk_family_revoked_denied');
RESET ROLE;
-- END P2-DB-01

SELECT * FROM finish();
ROLLBACK;
