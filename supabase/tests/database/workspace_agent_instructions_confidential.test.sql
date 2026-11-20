-- workspace_agent_instructions_confidential.test.sql — 20261120200001 (Q-9c, F-1):
-- custom_agents.instructions is not readable by authenticated, not even for
-- organization agents visible in the catalogue. Editors (owner, member, not
-- viewer) read it through custom_agent_instructions; running an agent reads it
-- through the server-only custom_agent_run_instructions (sso_control). Partial
-- saves never read the column and still bump the version exactly once.
BEGIN;
SELECT plan(34);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e7111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_aic_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_aic_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_aic_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_aic_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','Instructions A','ws-aic-a'), ('e7b00000-0000-4000-8000-00000000000b','Instructions B','ws-aic-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','owner'),
 ('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','agent'),
 ('e7a00000-0000-4000-8000-00000000000a','e7444444-4444-4444-8444-444444444444','agent'),
 ('e7b00000-0000-4000-8000-00000000000b','e7333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.custom_agents (id, organization_id, owner_user_id, name, instructions, visibility) VALUES
 ('e7d00000-0000-4000-8000-000000000001','e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','Org bot','ORG-SECRET: escalate to legal','organization'),
 ('e7d00000-0000-4000-8000-000000000002','e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','Desk','MEMBER-SECRET: private desk rules','private'),
 ('e7d00000-0000-4000-8000-000000000003','e7a00000-0000-4000-8000-00000000000a','e7444444-4444-4444-8444-444444444444','Viewer bot','VIEWER-SECRET','organization'),
 ('e7d00000-0000-4000-8000-0000000000b1','e7b00000-0000-4000-8000-00000000000b','e7333333-3333-4333-8333-333333333333','B bot','B-SECRET','organization');
-- The third member owns an organization agent but is demoted to viewer: readable, not editable.
UPDATE public.organization_members SET role = 'viewer' WHERE user_id = 'e7444444-4444-4444-8444-444444444444';

-- Runs custom_agent_run_instructions AS sso_control (pgTAP is not resolvable by that role).
CREATE FUNCTION pg_temp.run_as_ctl(p_org uuid, p_user uuid, p_agent uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v text;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.custom_agent_run_instructions(p_org, p_user, p_agent);
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.ids(p_org uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(string_agg(agent_id::text || '=' || instructions, ',' ORDER BY agent_id), '')
  FROM public.custom_agent_instructions(p_org, ARRAY['e7d00000-0000-4000-8000-000000000001','e7d00000-0000-4000-8000-000000000002',
    'e7d00000-0000-4000-8000-000000000003','e7d00000-0000-4000-8000-0000000000b1']::uuid[]) $f$;

-- Grants (as postgres).
SELECT ok(NOT has_column_privilege('authenticated','public.custom_agents','instructions','SELECT'), 'authenticated: no SELECT on instructions'); -- 1
SELECT ok(NOT has_column_privilege('anon','public.custom_agents','instructions','SELECT'), 'anon: no SELECT on instructions'); -- 2
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['id','organization_id','owner_user_id','name','description','model_key','visibility','tools',
  'conversation_starters','version','created_at','updated_at']) c WHERE has_column_privilege('authenticated','public.custom_agents',c,'SELECT')), 12,
  'every other column stays readable'); -- 3
SELECT ok(has_column_privilege('authenticated','public.custom_agents','instructions','INSERT')
  AND has_column_privilege('authenticated','public.custom_agents','instructions','UPDATE'), 'owners can still write instructions'); -- 4
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = 'public.custom_agent_instructions(uuid,uuid[])'::regprocedure)
  AND (SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = 'public.custom_agent_run_instructions(uuid,uuid,uuid)'::regprocedure),
  'both RPCs: SECURITY DEFINER, pinned search_path'); -- 5
SELECT ok(has_function_privilege('authenticated','public.custom_agent_instructions(uuid,uuid[])','EXECUTE')
  AND NOT has_function_privilege('anon','public.custom_agent_instructions(uuid,uuid[])','EXECUTE'), 'editor RPC: authenticated yes, anon no'); -- 6
SELECT ok(NOT has_function_privilege('authenticated','public.custom_agent_run_instructions(uuid,uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.custom_agent_run_instructions(uuid,uuid,uuid)','EXECUTE')
  AND has_function_privilege('sso_control','public.custom_agent_run_instructions(uuid,uuid,uuid)','EXECUTE'), 'run RPC: sso_control only'); -- 7
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
  WHERE p.oid IN ('public.custom_agent_instructions(uuid,uuid[])'::regprocedure, 'public.custom_agent_run_instructions(uuid,uuid,uuid)'::regprocedure)
    AND x.grantee = 0), 'no PUBLIC execute on either RPC'); -- 8
SELECT ok(pg_get_functiondef('public.save_custom_agent(uuid,uuid,jsonb,uuid[])'::regprocedure) NOT LIKE '%a.instructions%',
  'save_custom_agent never reads the instructions column'); -- 9

-- A member reading the catalogue directly (what PostgREST would run).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e7222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok($$SELECT instructions FROM public.custom_agents WHERE id = 'e7d00000-0000-4000-8000-000000000001'$$,
  '42501', NULL, 'member cannot SELECT the org agent''s instructions'); -- 10
SELECT throws_ok($$SELECT * FROM public.custom_agents$$, '42501', NULL, 'SELECT * is denied (select=* in PostgREST)'); -- 11
SELECT throws_ok($$SELECT count(*) FROM public.custom_agents WHERE instructions LIKE 'ORG-SECRET%'$$,
  '42501', NULL, 'no filtering on instructions either (no oracle)'); -- 12
SELECT throws_ok($$SELECT instructions FROM public.custom_agents WHERE id = 'e7d00000-0000-4000-8000-000000000002'$$,
  '42501', NULL, 'not even the owner reads it directly'); -- 13
SELECT is((SELECT string_agg(name, ',' ORDER BY name) FROM public.custom_agents), 'Desk,Org bot,Viewer bot', 'catalogue rows stay visible'); -- 14
SELECT throws_ok($$SELECT public.custom_agent_run_instructions('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','e7d00000-0000-4000-8000-000000000001')$$,
  '42501', NULL, 'authenticated cannot call the server-only run RPC'); -- 15

-- Editor RPC.
SELECT is(pg_temp.ids('e7a00000-0000-4000-8000-00000000000a'), 'e7d00000-0000-4000-8000-000000000002=MEMBER-SECRET: private desk rules',
  'member gets only the agent they own'); -- 16
SELECT is(pg_temp.ids('e7b00000-0000-4000-8000-00000000000b'), '', 'member gets nothing with another org id'); -- 17
SELECT set_config('request.jwt.claims','{"sub":"e7111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is(pg_temp.ids('e7a00000-0000-4000-8000-00000000000a'), 'e7d00000-0000-4000-8000-000000000001=ORG-SECRET: escalate to legal',
  'org owner gets only their own agent, not a member''s'); -- 18
SELECT set_config('request.jwt.claims','{"sub":"e7444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT is(pg_temp.ids('e7a00000-0000-4000-8000-00000000000a'), '', 'an owner demoted to viewer gets nothing'); -- 19
SELECT set_config('request.jwt.claims','{"sub":"e7333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is(pg_temp.ids('e7a00000-0000-4000-8000-00000000000a'), '', 'other tenant gets nothing for A'); -- 20
SELECT is(pg_temp.ids('e7b00000-0000-4000-8000-00000000000b'), 'e7d00000-0000-4000-8000-0000000000b1=B-SECRET', 'other tenant gets only its own'); -- 21
SELECT throws_ok($$SELECT * FROM public.custom_agent_instructions('e7b00000-0000-4000-8000-00000000000b', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 201)))$$,
  '22023', 'INVALID_REQUEST', 'more than 200 ids rejected'); -- 22
SELECT throws_ok($$SELECT * FROM public.custom_agent_instructions('e7b00000-0000-4000-8000-00000000000b', NULL)$$, '22023', 'INVALID_REQUEST', 'NULL ids rejected'); -- 23
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SELECT throws_ok($$SELECT * FROM public.custom_agent_instructions('e7a00000-0000-4000-8000-00000000000a', ARRAY['e7d00000-0000-4000-8000-000000000001']::uuid[])$$,
  '42501', 'FORBIDDEN', 'no user id: FORBIDDEN'); -- 24
RESET ROLE;

-- Server-only run RPC (as sso_control).
SELECT is(pg_temp.run_as_ctl('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','e7d00000-0000-4000-8000-000000000001'),
  'ORG-SECRET: escalate to legal', 'a reader runs the org agent with its instructions (server side)'); -- 25
SELECT is(pg_temp.run_as_ctl('e7a00000-0000-4000-8000-00000000000a','e7444444-4444-4444-8444-444444444444','e7d00000-0000-4000-8000-000000000001'),
  'ORG-SECRET: escalate to legal', 'a viewer can run (read) an org agent'); -- 26
SELECT is(pg_temp.run_as_ctl('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7d00000-0000-4000-8000-000000000002'),
  NULL, 'nobody else runs a private agent'); -- 27
SELECT is(pg_temp.run_as_ctl('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333','e7d00000-0000-4000-8000-000000000001'),
  NULL, 'a non-member gets nothing'); -- 28
SELECT is(pg_temp.run_as_ctl('e7b00000-0000-4000-8000-00000000000b','e7222222-2222-4222-8222-222222222222','e7d00000-0000-4000-8000-000000000001'),
  NULL, 'wrong organization id gets nothing'); -- 29
SELECT is(pg_temp.run_as_ctl('e7a00000-0000-4000-8000-00000000000a',NULL,'e7d00000-0000-4000-8000-000000000001'), NULL, 'NULL user gets nothing'); -- 30

-- Saves still work without reading the column; version bumps once.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e7222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT set_config('t.v', (SELECT version::text FROM public.custom_agents WHERE id = 'e7d00000-0000-4000-8000-000000000002'), true);
SELECT lives_ok($$SELECT public.save_custom_agent('e7a00000-0000-4000-8000-00000000000a','e7d00000-0000-4000-8000-000000000002','{"name":"Desk 2"}')$$,
  'partial save without instructions works for the owner'); -- 31
SELECT lives_ok($$SELECT public.save_custom_agent('e7a00000-0000-4000-8000-00000000000a','e7d00000-0000-4000-8000-000000000002','{"instructions":"New rules."}')$$,
  'save with instructions works for the owner'); -- 32
RESET ROLE;
SELECT is((SELECT row(name, instructions, version - current_setting('t.v')::int)::text FROM public.custom_agents WHERE id = 'e7d00000-0000-4000-8000-000000000002'),
  row('Desk 2', 'New rules.', 2)::text, 'name kept, instructions written, one version bump per save'); -- 33
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e7111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.save_custom_agent('e7a00000-0000-4000-8000-00000000000a','e7d00000-0000-4000-8000-000000000002','{"name":"Hijack"}')$$,
  'P0002', 'NOT_FOUND', 'a non-owner still cannot save someone else''s agent'); -- 34
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
