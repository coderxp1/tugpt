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

SELECT ok(sso.issue_verified_ticket(repeat('b',64),'11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444',floor(extract(epoch from clock_timestamp()))::bigint+600,floor(extract(epoch from clock_timestamp()))::bigint,'m01-owner@example.invalid'),'verified ticket issued');
UPDATE sso.tickets SET verified_at=clock_timestamp()-interval '20 seconds' WHERE hash=repeat('b',64);
CREATE TEMP TABLE original_verification AS SELECT verified_at FROM sso.tickets WHERE hash=repeat('b',64);
SELECT ok(sso.consume_ticket(repeat('b',64),repeat('c',64)) IS NOT NULL,'evidence ticket consumed');
SELECT is((SELECT email_verified_at FROM sso.sessions WHERE hash=repeat('c',64)),(SELECT verified_at FROM original_verification),'consume preserves original verification time');
SELECT is((SELECT canonical_email FROM sso.sessions WHERE hash=repeat('c',64)),'m01-owner@example.invalid','email evidence transfers');
SELECT throws_ok($q$SELECT sso.issue_verified_ticket(repeat('d',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',0,0,'bad email')$q$,'22023',NULL,'invalid email shape refused');
SELECT is(sso.require_session(),'11111111-1111-1111-1111-111111111111'::uuid,'active bridge actor');
SELECT is(sso.require_actor('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false),'11111111-1111-1111-1111-111111111111'::uuid,'current membership required');
SELECT throws_ok($q$SELECT sso.require_actor('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',false)$q$,'42501',NULL,'foreign tenant denied');
SELECT throws_ok($q$SELECT sso.feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','unknown')$q$,'42501',NULL,'feature allowlist enforced');
SELECT lives_ok($q$SELECT sso.feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ai_draft_generation')$q$,'ordinary feature query allowed for member');
SELECT ok(NOT has_function_privilege('authenticated','sso.require_session()','EXECUTE'),'internal session helper denied directly');
SELECT ok(NOT has_function_privilege('sso_control','sso.require_actor(uuid,boolean)','EXECUTE'),'internal actor helper denied to control role');
UPDATE sso.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE hash=repeat('a',64);
SELECT throws_ok($q$SELECT sso.require_actor('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false)$q$,'28000',NULL,'expired session cannot query features');
-- Deterministic lock-wait expiry/membership races are in H17, not simulated here.
SELECT * FROM finish();
ROLLBACK;
