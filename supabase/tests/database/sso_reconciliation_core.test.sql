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

SELECT ok(sso.issue_ticket(repeat('1',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',floor(extract(epoch from clock_timestamp()))::bigint+3600,floor(extract(epoch from clock_timestamp()))::bigint),'fresh ticket issued');
SELECT ok((SELECT expires_at <= verified_at+interval '30 seconds' AND session_deadline <= verified_at+interval '15 minutes' FROM sso.tickets WHERE hash=repeat('1',64)),'ticket/session time ceilings');
SELECT ok(sso.consume_ticket(repeat('1',64),repeat('2',64)) IS NOT NULL,'ticket consumed');
SELECT is(sso.consume_ticket(repeat('1',64),repeat('3',64)),NULL::jsonb,'ticket cannot be replayed');
SELECT is(sso.load_session(repeat('2',64))->>'mapped','true','mapped same UUID session');
DELETE FROM sso.identity_bindings WHERE canonical_sub='11111111-1111-1111-1111-111111111111';
SELECT is(sso.load_session(repeat('2',64))->>'mapped','false','unmapped identity is not provisioned');
SELECT sso.logout_session(repeat('2',64));
SELECT is(sso.load_session(repeat('2',64)),NULL::jsonb,'local logout invalidates session');
SELECT ok(NOT sso.issue_ticket(repeat('4',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',floor(extract(epoch from clock_timestamp()))::bigint+3600,floor(extract(epoch from clock_timestamp()))::bigint-901),'old canonical iat cannot extend window');
SELECT ok(NOT sso.issue_ticket(repeat('4',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',floor(extract(epoch from clock_timestamp()))::bigint-1,floor(extract(epoch from clock_timestamp()))::bigint),'expired token refused');
SELECT ok(NOT sso.issue_ticket(repeat('4',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',floor(extract(epoch from clock_timestamp()))::bigint+3600,floor(extract(epoch from clock_timestamp()))::bigint+60),'future canonical iat refused');
SELECT sso.revoke_auth_session('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333');
SELECT ok(NOT sso.issue_ticket(repeat('5',64),'11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',floor(extract(epoch from clock_timestamp()))::bigint+3600,floor(extract(epoch from clock_timestamp()))::bigint),'family tombstone blocks issue');
SELECT ok(sso.limit_request('p2-core-test',1),'first limiter attempt allowed');
SELECT ok(NOT sso.limit_request('p2-core-test',1),'over-limit attempt refused');
SELECT ok(NOT sso.limit_request('p2-core-test',121),'out-of-range rate limit refused');
UPDATE sso.revoked_auth_sessions SET revoked_at=clock_timestamp()-interval '2 days' WHERE subject='11111111-1111-1111-1111-111111111111' AND auth_session='33333333-3333-3333-3333-333333333333';
SELECT sso.cleanup_expired();
SELECT ok(EXISTS(SELECT 1 FROM sso.revoked_auth_sessions WHERE subject='11111111-1111-1111-1111-111111111111' AND auth_session='33333333-3333-3333-3333-333333333333'),'cleanup retains tombstones');
SELECT * FROM finish();
ROLLBACK;
