-- create_images.test.sql — 20261115000002: per-user, per-organization image history.
-- Two organizations, an owner and a member in A, an owner in B.
BEGIN;
SELECT plan(16);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f1111111-1111-4111-8111-111111111111','authenticated','authenticated','img_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f2222222-2222-4222-8222-222222222222','authenticated','authenticated','img_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f3333333-3333-4333-8333-333333333333','authenticated','authenticated','img_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('fa000000-0000-4000-8000-00000000000a','Img A','img-a'),
 ('fb000000-0000-4000-8000-00000000000b','Img B','img-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('fa000000-0000-4000-8000-00000000000a','f1111111-1111-4111-8111-111111111111','owner'),
 ('fa000000-0000-4000-8000-00000000000a','f2222222-2222-4222-8222-222222222222','agent'),
 ('fb000000-0000-4000-8000-00000000000b','f3333333-3333-4333-8333-333333333333','owner');

-- 1-3 lockdown
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.image_generations'::regclass), 'RLS enabled and forced'); -- 1
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('anon','public.image_generations',p)), 0, 'anon has no privilege'); -- 2
SELECT ok(NOT has_table_privilege('authenticated','public.image_generations','DELETE')
  AND NOT has_column_privilege('authenticated','public.image_generations','prompt','UPDATE')
  AND NOT has_column_privilege('authenticated','public.image_generations','organization_id','UPDATE')
  AND NOT has_column_privilege('authenticated','public.image_generations','owner_user_id','UPDATE')
  AND has_column_privilege('authenticated','public.image_generations','status','UPDATE'), 'only status fields are updatable; no delete'); -- 3

-- member A2
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.image_generations (id, organization_id, owner_user_id, prompt, width, height, seed, model_key)
  VALUES ('f7000000-0000-4000-8000-000000000001','fa000000-0000-4000-8000-00000000000a','f2222222-2222-4222-8222-222222222222','A red bicycle',1024,1024,42,'Tongyi-MAI/Z-Image-Turbo')$$, 'member records own generation'); -- 4
SELECT throws_ok($$INSERT INTO public.image_generations (id, organization_id, owner_user_id, prompt, width, height, seed, model_key)
  VALUES ('f7000000-0000-4000-8000-000000000002','fb000000-0000-4000-8000-00000000000b','f2222222-2222-4222-8222-222222222222','x',1024,1024,1,'m')$$, '42501', NULL, 'cannot record into an organization one is not a member of'); -- 5
SELECT throws_ok($$INSERT INTO public.image_generations (id, organization_id, owner_user_id, prompt, width, height, seed, model_key)
  VALUES ('f7000000-0000-4000-8000-000000000003','fa000000-0000-4000-8000-00000000000a','f1111111-1111-4111-8111-111111111111','x',1024,1024,1,'m')$$, '42501', NULL, 'cannot record a generation owned by someone else'); -- 6
SELECT throws_ok($$INSERT INTO public.image_generations (id, organization_id, owner_user_id, prompt, width, height, seed, model_key)
  VALUES ('f7000000-0000-4000-8000-000000000004','fa000000-0000-4000-8000-00000000000a','f2222222-2222-4222-8222-222222222222','x',999,999,1,'m')$$, '23514', NULL, 'unsupported size is rejected'); -- 7
SELECT throws_ok($$UPDATE public.image_generations SET prompt='changed'$$, '42501', NULL, 'prompt is immutable'); -- 8
SELECT lives_ok($$UPDATE public.image_generations SET status='completed', progress=100 WHERE id='f7000000-0000-4000-8000-000000000001'$$, 'owner records a status change'); -- 9
SELECT is((SELECT status FROM public.image_generations WHERE id='f7000000-0000-4000-8000-000000000001'), 'completed', 'member sees own generation with the recorded status'); -- 10

-- owner A1 of the same organization: no access to a colleague's prompts or images
SELECT set_config('request.jwt.claims','{"sub":"f1111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.image_generations), 0, 'org owner cannot read a member''s generations'); -- 11
UPDATE public.image_generations SET status='failed', error_code='TAMPERED';

-- owner B1 of another organization
SELECT set_config('request.jwt.claims','{"sub":"f3333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.image_generations), 0, 'other tenant sees nothing'); -- 12
UPDATE public.image_generations SET status='cancelled', error_code='TAMPERED';

RESET ROLE;
SELECT is((SELECT status || '/' || coalesce(error_code,'-') FROM public.image_generations WHERE id='f7000000-0000-4000-8000-000000000001'),
  'completed/-', 'neither the org owner nor another tenant could change the row'); -- 13

-- A2 leaves organization A: history becomes unreachable
DELETE FROM public.organization_members WHERE user_id='f2222222-2222-4222-8222-222222222222';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f2222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.image_generations), 0, 'former member loses read access'); -- 14
SELECT throws_ok($$INSERT INTO public.image_generations (id, organization_id, owner_user_id, prompt, width, height, seed, model_key)
  VALUES ('f7000000-0000-4000-8000-000000000005','fa000000-0000-4000-8000-00000000000a','f2222222-2222-4222-8222-222222222222','x',1024,1024,1,'m')$$, '42501', NULL, 'former member cannot record new generations'); -- 15
UPDATE public.image_generations SET status='failed', error_code='TAMPERED';
RESET ROLE;
SELECT is((SELECT status FROM public.image_generations WHERE id='f7000000-0000-4000-8000-000000000001'), 'completed', 'former member cannot write'); -- 16

SELECT * FROM finish();
ROLLBACK;
