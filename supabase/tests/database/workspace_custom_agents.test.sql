-- workspace_custom_agents.test.sql — 20261120100004: custom agents,
-- visibility and roles, validated tool selection, server-maintained version,
-- knowledge links that require collection access, threads started from an
-- agent, cross-tenant rejection and audit.
BEGIN;
SELECT plan(34);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','ea111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_ag_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ea222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_ag_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ea444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_ag_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','ea333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_ag_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('eaa00000-0000-4000-8000-00000000000a','Agents A','ws-ag-a'), ('eab00000-0000-4000-8000-00000000000b','Agents B','ws-ag-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','owner'),
 ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','agent'),
 ('eaa00000-0000-4000-8000-00000000000a','ea444444-4444-4444-8444-444444444444','viewer'),
 ('eab00000-0000-4000-8000-00000000000b','ea333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility) VALUES
 ('eac00000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Member private','private'),
 ('eac00000-0000-4000-8000-000000000002','eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','Owner private','private'),
 ('eac00000-0000-4000-8000-000000000003','eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','Company','organization'),
 ('eac00000-0000-4000-8000-0000000000bb','eab00000-0000-4000-8000-00000000000b','ea333333-3333-4333-8333-333333333333','B','organization');

SELECT ok((SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c WHERE c.oid IN ('public.custom_agents'::regclass,'public.custom_agent_collections'::regclass)), 'RLS enabled and forced'); -- 1
SELECT ok(NOT has_column_privilege('authenticated','public.custom_agents','version','UPDATE')
  AND NOT has_column_privilege('authenticated','public.custom_agents','owner_user_id','UPDATE')
  AND NOT has_column_privilege('authenticated','public.custom_agents','organization_id','UPDATE')
  AND NOT has_column_privilege('authenticated','public.custom_agents','version','INSERT')
  AND NOT has_table_privilege('anon','public.custom_agents','SELECT'), 'identity and version are not client-writable'); -- 2

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"ea222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$INSERT INTO public.custom_agents (id, organization_id, owner_user_id, name, instructions, model_key, tools, conversation_starters)
  VALUES ('ead00000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Travel helper','Answer travel policy questions.','tugpt-scout',
  '[{"capability":"calendar","provider":"google"}]','{"What is the hotel limit?"}')$$, 'member creates a private agent'); -- 3
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name, visibility) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Org','organization')$$, '42501', NULL, 'members cannot publish agents to the organization'); -- 4
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','Spoof')$$, '42501', NULL, 'cannot create an agent owned by someone else'); -- 5
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name) VALUES ('eab00000-0000-4000-8000-00000000000b','ea222222-2222-4222-8222-222222222222','X')$$, '42501', NULL, 'cannot create in another organization'); -- 6
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name, tools) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','T','[{"capability":"calendar","provider":"google","connection_id":"x"}]')$$, '23514', NULL, 'tools carry only capability/provider keys'); -- 7
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name, tools) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','T','[{"capability":"calendar","provider":"google"},{"capability":"calendar","provider":"google"}]')$$, '23514', NULL, 'duplicate tools rejected'); -- 8
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name, tools) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','T','{"capability":"calendar"}')$$, '23514', NULL, 'tools must be an array'); -- 9
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name, conversation_starters) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','S','{a,b,c,d,e,f,g}')$$, '23514', NULL, 'at most six conversation starters'); -- 10
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name, instructions) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','I', repeat('x', 20001))$$, '23514', NULL, 'instructions bounded at 20000 characters'); -- 11
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222', E'bad\nname')$$, '23514', NULL, 'control characters rejected in names'); -- 12

UPDATE public.custom_agents SET instructions = 'Answer travel and expense policy questions.' WHERE id = 'ead00000-0000-4000-8000-000000000001';
SELECT is((SELECT version FROM public.custom_agents WHERE id = 'ead00000-0000-4000-8000-000000000001'), 2, 'editing bumps the version'); -- 13
UPDATE public.custom_agents SET name = name WHERE id = 'ead00000-0000-4000-8000-000000000001';
SELECT is((SELECT version FROM public.custom_agents WHERE id = 'ead00000-0000-4000-8000-000000000001'), 2, 'a no-op update keeps the version'); -- 14
SELECT throws_ok($$UPDATE public.custom_agents SET visibility = 'organization' WHERE id = 'ead00000-0000-4000-8000-000000000001'$$, '42501', NULL, 'members cannot publish by update'); -- 15

SELECT lives_ok($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES ('ead00000-0000-4000-8000-000000000001','eac00000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222')$$, 'link own collection'); -- 16
SELECT lives_ok($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES ('ead00000-0000-4000-8000-000000000001','eac00000-0000-4000-8000-000000000003','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222')$$, 'link a readable organization collection'); -- 17
SELECT throws_ok($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES ('ead00000-0000-4000-8000-000000000001','eac00000-0000-4000-8000-000000000002','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222')$$, '42501', NULL, 'cannot link a collection one cannot read'); -- 18
SELECT throws_ok($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES ('ead00000-0000-4000-8000-000000000001','eac00000-0000-4000-8000-0000000000bb','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222')$$, '42501', NULL, 'cannot link another tenant''s collection'); -- 19
SELECT lives_ok($$INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key, agent_id) VALUES ('ea700000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222','Trip','tugpt-scout','ead00000-0000-4000-8000-000000000001')$$, 'start a conversation from own agent'); -- 20

-- Org owner: cannot see or change the member's private agent; publishes an org agent.
SELECT set_config('request.jwt.claims','{"sub":"ea111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE id = 'ead00000-0000-4000-8000-000000000001')
  + (SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = 'ead00000-0000-4000-8000-000000000001'), 0, 'private agents are invisible to the org owner'); -- 21
WITH d AS (DELETE FROM public.custom_agents WHERE id = 'ead00000-0000-4000-8000-000000000001' RETURNING 1) SELECT is(count(*)::int, 0, 'org owner cannot delete a member''s private agent') FROM d; -- 22
SELECT throws_ok($$INSERT INTO public.chat_threads (organization_id, owner_user_id, title, model_key, agent_id) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','X','tugpt-scout','ead00000-0000-4000-8000-000000000001')$$, '42501', NULL, 'cannot start a conversation from an unreadable agent'); -- 23
SELECT lives_ok($$INSERT INTO public.custom_agents (id, organization_id, owner_user_id, name, visibility) VALUES ('ead00000-0000-4000-8000-000000000002','eaa00000-0000-4000-8000-00000000000a','ea111111-1111-4111-8111-111111111111','HR assistant','organization')$$, 'owner publishes an organization agent'); -- 24

SELECT set_config('request.jwt.claims','{"sub":"ea444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE organization_id = 'eaa00000-0000-4000-8000-00000000000a'), 1, 'viewer sees organization agents only'); -- 25
SELECT throws_ok($$INSERT INTO public.custom_agents (organization_id, owner_user_id, name) VALUES ('eaa00000-0000-4000-8000-00000000000a','ea444444-4444-4444-8444-444444444444','V')$$, '42501', NULL, 'viewers cannot create agents'); -- 26
WITH u AS (UPDATE public.custom_agents SET name = 'Hijack' WHERE id = 'ead00000-0000-4000-8000-000000000002' RETURNING 1) SELECT is(count(*)::int, 0, 'viewers cannot edit organization agents') FROM u; -- 27

SELECT set_config('request.jwt.claims','{"sub":"ea222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
WITH u AS (UPDATE public.custom_agents SET instructions = 'x' WHERE id = 'ead00000-0000-4000-8000-000000000002' RETURNING 1) SELECT is(count(*)::int, 0, 'members cannot edit organization agents they do not own') FROM u; -- 28
SELECT throws_ok($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES ('ead00000-0000-4000-8000-000000000002','eac00000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-00000000000a','ea222222-2222-4222-8222-222222222222')$$, '42501', NULL, 'members cannot attach knowledge to an agent they cannot edit'); -- 29

SELECT set_config('request.jwt.claims','{"sub":"ea333333-3333-4333-8333-333333333333","role":"authenticated"}',true);
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE organization_id = 'eaa00000-0000-4000-8000-00000000000a'), 0, 'other tenant sees no agents of A'); -- 30
SELECT throws_ok($$INSERT INTO public.chat_threads (organization_id, owner_user_id, title, model_key, agent_id) VALUES ('eab00000-0000-4000-8000-00000000000b','ea333333-3333-4333-8333-333333333333','X','tugpt-scout','ead00000-0000-4000-8000-000000000002')$$, NULL, NULL, 'cannot attach another tenant''s agent to a conversation'); -- 31

SELECT set_config('request.jwt.claims','{"sub":"ea222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
DELETE FROM public.custom_agents WHERE id = 'ead00000-0000-4000-8000-000000000001';
SELECT ok((SELECT agent_id IS NULL AND organization_id = 'eaa00000-0000-4000-8000-00000000000a' FROM public.chat_threads WHERE id = 'ea700000-0000-4000-8000-000000000001'), 'deleting an agent keeps its conversations'); -- 32
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = 'ead00000-0000-4000-8000-000000000001'), 0, 'links go with the agent'); -- 33
SELECT is((SELECT array_agg(DISTINCT action ORDER BY action) FROM public.audit_logs WHERE organization_id = 'eaa00000-0000-4000-8000-00000000000a' AND action LIKE 'workspace.agent.%'),
  ARRAY['workspace.agent.collection_linked','workspace.agent.collection_unlinked','workspace.agent.created','workspace.agent.deleted','workspace.agent.updated'], 'agent operations are audited'); -- 34

SELECT * FROM finish();
ROLLBACK;
