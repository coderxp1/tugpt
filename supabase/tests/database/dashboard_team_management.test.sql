-- Dashboard Backend M1 (Agent 7): team and organization management.
-- Real RLS/role checks: every customer action runs as `authenticated` with JWT
-- claims; every assertion about stored state runs as postgres. Rolled back.
BEGIN;
SELECT plan(58);

-- Fixtures -----------------------------------------------------------------
INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,
  raw_app_meta_data,raw_user_meta_data,is_super_admin,confirmation_token,recovery_token,email_change_token_new,email_change)
SELECT '00000000-0000-0000-0000-000000000000', u.id::uuid,'authenticated','authenticated',u.email,'',now(),now(),now(),'{}','{}',false,'','','',''
FROM (VALUES
  ('a7000000-0000-4000-8000-000000000001','m1-owner-a@example.test'),
  ('a7000000-0000-4000-8000-000000000002','m1-admin-a@example.test'),
  ('a7000000-0000-4000-8000-000000000003','m1-admin2-a@example.test'),
  ('a7000000-0000-4000-8000-000000000004','m1-manager-a@example.test'),
  ('a7000000-0000-4000-8000-000000000005','m1-agent-a@example.test'),
  ('a7000000-0000-4000-8000-000000000006','m1-viewer-a@example.test'),
  ('a7000000-0000-4000-8000-000000000007','m1-owner-b@example.test'),
  ('a7000000-0000-4000-8000-000000000008','m1-outsider@example.test'),
  ('a7000000-0000-4000-8000-000000000009','m1-agent-b@example.test'),
  ('a7000000-0000-4000-8000-000000000010','m1-invitee@example.test')
) AS u(id,email);

INSERT INTO public.organizations(id,name,slug) VALUES
  ('a7a00000-0000-4000-8000-00000000000a','M1 Tenant A','m1-tenant-a'),
  ('a7a00000-0000-4000-8000-00000000000b','M1 Tenant B','m1-tenant-b');
INSERT INTO public.organization_members(organization_id,user_id,role) VALUES
  ('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000001','owner'),
  ('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000002','admin'),
  ('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000003','admin'),
  ('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000004','manager'),
  ('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000005','agent'),
  ('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000006','viewer'),
  ('a7a00000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-000000000007','owner'),
  ('a7a00000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-000000000009','agent');

CREATE TEMP TABLE m1_ids(k text PRIMARY KEY, v text);
GRANT ALL ON m1_ids TO authenticated;
CREATE TEMP VIEW m1_audit AS SELECT action, details FROM public.audit_logs
  WHERE organization_id='a7a00000-0000-4000-8000-00000000000a';

-- 1. Direct add is refused (invitation-only membership) ---------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000008','add','agent')$$,
  'P3S02',NULL,'T1: admin cannot add an arbitrary user id');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000008','add','viewer')$$,
  'P3S02',NULL,'T2: owner cannot add an arbitrary user id either');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE user_id='a7000000-0000-4000-8000-000000000008'),0,
  'T3: no membership was created for the outsider');

-- 2. Admin rules ---------------------------------------------------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT is((public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000005','set_role','manager'))->>'changed',
  'true','T4: admin promotes agent to manager');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000006','set_role','owner')$$,
  'P3S02',NULL,'T5: admin cannot assign owner');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000003','set_role','viewer')$$,
  'P3S07',NULL,'T6: admin cannot demote a peer admin');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000003','remove')$$,
  'P3S07',NULL,'T7: admin cannot remove a peer admin');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000001','remove')$$,
  'P3S02',NULL,'T8: admin cannot remove the owner');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000009','set_role','viewer')$$,
  'P3S06',NULL,'T9: a user who is not in this organization is "member not found"');
SELECT is((public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000006','set_role','admin'))->>'role',
  'admin','T10: admin may assign up to their own rank');
RESET ROLE;
SELECT is((SELECT role::text FROM public.organization_members WHERE organization_id='a7a00000-0000-4000-8000-00000000000a' AND user_id='a7000000-0000-4000-8000-000000000005'),
  'manager','T11: promotion is stored');
SELECT is((SELECT details->>'previous_role' FROM m1_audit WHERE action='membership.set_role' AND details->>'subject_id'='a7000000-0000-4000-8000-000000000005'),
  'agent','T12: promotion is audited with the previous role');
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE organization_id='a7a00000-0000-4000-8000-00000000000a' AND role IN ('owner','admin')),
  4,'T13: refused operations changed nothing (owner + 2 admins + promoted viewer)');

-- 3. Lower roles cannot manage anyone -------------------------------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000005','set_role','viewer')$$,
  'P3S02',NULL,'T14: manager cannot change roles');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000004','remove')$$,
  'P3S02',NULL,'T15: a non-admin cannot remove someone else');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000005','set_role','owner')$$,
  'P3S02',NULL,'T16: a non-admin cannot escalate their own role');

-- 4. Cross-tenant -----------------------------------------------------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000007","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000004','remove')$$,
  'P3S01',NULL,'T17: owner of B cannot remove a member of A');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000004','set_role','viewer')$$,
  'P3S01',NULL,'T18: owner of B cannot change roles in A');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-000000000009','remove')$$,
  'P3S01',NULL,'T19: owner of A cannot remove a member of B');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000007','remove')$$,
  'P3S06',NULL,'T20: owner of A naming B''s owner under A''s id finds no member');
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE organization_id='a7a00000-0000-4000-8000-00000000000b'),
  0,'T21: authenticated user of A sees no rows of B through RLS');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE organization_id='a7a00000-0000-4000-8000-00000000000b'),
  2,'T22: tenant B membership untouched');
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE organization_id='a7a00000-0000-4000-8000-00000000000a' AND user_id='a7000000-0000-4000-8000-000000000004'),
  1,'T23: tenant A manager untouched by B''s attempts');

-- 5. Owner powers, no-op, leave, last owner ---------------------------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
INSERT INTO m1_ids VALUES ('audit_before',(SELECT count(*) FROM public.audit_logs WHERE organization_id='a7a00000-0000-4000-8000-00000000000a')::text);
SELECT is((public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000004','set_role','manager'))->>'changed',
  'false','T24: setting the current role is a no-op');
SELECT is((SELECT count(*) FROM public.audit_logs WHERE organization_id='a7a00000-0000-4000-8000-00000000000a')::text,
  (SELECT v FROM m1_ids WHERE k='audit_before'),'T25: a no-op writes no audit row');
SELECT is((public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000003','set_role','agent'))->>'previous_role',
  'admin','T26: owner may demote an admin');
SELECT is((public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000003','remove'))->>'action',
  'remove','T27: owner may remove a member');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000001','remove')$$,
  'P3S05',NULL,'T28: the last owner cannot leave');
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000001','set_role','admin')$$,
  'P3S05',NULL,'T29: the last owner cannot demote themself');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000004','remove'))->>'action',
  'remove','T30: any member may leave');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM m1_audit WHERE action='membership.remove' AND details->>'subject_id'='a7000000-0000-4000-8000-000000000003'),
  1,'T31: removal is audited as membership.remove');
SELECT is((SELECT count(*)::int FROM m1_audit WHERE action='membership.leave' AND details->>'subject_id'='a7000000-0000-4000-8000-000000000004'),
  1,'T32: leaving is audited as membership.leave');
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id='a7a00000-0000-4000-8000-00000000000b'),
  0,'T33: no audit rows were written to tenant B');

-- 6. Organization settings --------------------------------------------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT is((public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a',
  '{"name":"  M1 Tenant A Renamed ","locale":"en","time_zone":"Europe/Madrid"}'))->>'name',
  'M1 Tenant A Renamed','T34: admin updates settings; name is trimmed');
SELECT is((public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"locale":"en"}'))->>'changed',
  'false','T35: unchanged settings report changed=false');
SELECT throws_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"time_zone":"Mars/Olympus"}')$$,
  'P3S03',NULL,'T36: invalid time zone refused');
SELECT throws_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"slug":"stolen"}')$$,
  'P3S03',NULL,'T37: slug is not a settable field');
SELECT throws_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"name":"   "}')$$,
  'P3S03',NULL,'T38: blank name refused');
SELECT throws_ok($$UPDATE public.organizations SET name='bypass' WHERE id='a7a00000-0000-4000-8000-00000000000a'$$,
  '42501',NULL,'T39: direct UPDATE on organizations is no longer granted (no audit bypass)');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"name":"x"}')$$,
  'P3S02',NULL,'T40: manager cannot change settings');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000007","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"name":"pwned"}')$$,
  'P3S01',NULL,'T41: owner of B cannot change A''s settings');
SELECT lives_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000b','{"name":"M1 Tenant B Renamed"}')$$,
  'T42: owner of B changes B''s settings');
RESET ROLE;
SELECT is((SELECT name||'|'||locale||'|'||time_zone FROM public.organizations WHERE id='a7a00000-0000-4000-8000-00000000000a'),
  'M1 Tenant A Renamed|en|Europe/Madrid','T43: A''s settings stored; B''s attempt had no effect');
SELECT is((SELECT details->'changes'->'name'->>'from' FROM m1_audit WHERE action='organization.update_settings'),
  'M1 Tenant A','T44: settings change audited with before/after, exactly once');

-- 7. Audit visibility follows tenant and role -----------------------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000009","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id='a7a00000-0000-4000-8000-00000000000b'),
  0,'T45: an agent cannot read their organization''s audit log');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000007","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id='a7a00000-0000-4000-8000-00000000000b'),
  1,'T46: B''s owner reads B''s audit log');
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE organization_id='a7a00000-0000-4000-8000-00000000000a'),
  0,'T47: B''s owner reads nothing of A''s audit log');

-- 8. Own profile (existing column grant + own-row policy, reused by the API) --------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT lives_ok($$UPDATE public.profiles SET full_name='Ana Agent',preferred_locale='en' WHERE id='a7000000-0000-4000-8000-000000000005'$$,
  'T48: a member updates their own name and language');
SELECT throws_ok($$UPDATE public.profiles SET email='evil@example.test' WHERE id='a7000000-0000-4000-8000-000000000005'$$,
  '42501',NULL,'T49: email is not a writable column');
UPDATE public.profiles SET full_name='bypass' WHERE id='a7000000-0000-4000-8000-000000000007';
RESET ROLE;
SELECT is((SELECT coalesce(full_name,'') FROM public.profiles WHERE id='a7000000-0000-4000-8000-000000000007'),
  '','T50: another person''s profile is not writable (RLS filters the row)');
SELECT is((SELECT coalesce(full_name,'')||'|'||preferred_locale FROM public.profiles WHERE id='a7000000-0000-4000-8000-000000000005'),
  'Ana Agent|en','T51: own profile stored');

-- 9. Invitation lifecycle end to end (existing RPCs, unchanged) -------------------
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
INSERT INTO m1_ids SELECT 'tok', public.create_invitation('a7a00000-0000-4000-8000-00000000000a','M1-Invitee@Example.test','agent')->>'token';
INSERT INTO m1_ids SELECT 'inv2', public.create_invitation('a7a00000-0000-4000-8000-00000000000a','m1-outsider@example.test','viewer')->>'invitation_id';
SELECT is((public.revoke_invitation((SELECT v FROM m1_ids WHERE k='inv2')::uuid))->>'status','revoked','T52: owner revokes a pending invitation');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000007","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.revoke_invitation((SELECT v FROM m1_ids WHERE k='inv2')::uuid)$$,
  'P3D01',NULL,'T53: another tenant''s invitation id is "not found"');
SELECT set_config('request.jwt.claims','{"sub":"a7000000-0000-4000-8000-000000000010","role":"authenticated"}',true);
SELECT is((public.accept_invitation((SELECT v FROM m1_ids WHERE k='tok')))->>'role','agent','T54: invitee accepts and joins at the invited role');
SELECT throws_ok($$SELECT public.accept_invitation((SELECT v FROM m1_ids WHERE k='tok'))$$,
  'P3D04',NULL,'T55: a used invitation cannot be accepted again');
RESET ROLE;
SELECT is((SELECT string_agg(action,',' ORDER BY action) FROM m1_audit WHERE action LIKE 'invitation.%'),
  'invitation.accept,invitation.create,invitation.create,invitation.revoke','T56: the whole invitation lifecycle is audited');

-- 10. Anonymous callers ----------------------------------------------------------
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.manage_organization_member('a7a00000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-000000000005','remove')$$,
  '42501',NULL,'T57: anon cannot execute member management');
SELECT throws_ok($$SELECT public.update_organization_settings('a7a00000-0000-4000-8000-00000000000a','{"name":"x"}')$$,
  '42501',NULL,'T58: anon cannot execute settings updates');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
