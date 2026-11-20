-- F-4: preserve existing RLS; canEdit must describe a save retaining visibility.
BEGIN;
SELECT no_plan();

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','f4111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_f4_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f4222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_f4_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f4444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_f4_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f4555555-5555-4555-8555-555555555555','authenticated','authenticated','ws_f4_admin_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','f4333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_f4_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('f4a00000-0000-4000-8000-00000000000a','OwnerEdit A','ws-f4-a'), ('f4b00000-0000-4000-8000-00000000000b','OwnerEdit B','ws-f4-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('f4a00000-0000-4000-8000-00000000000a','f4111111-1111-4111-8111-111111111111','owner'),
 ('f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222','agent'),
 ('f4a00000-0000-4000-8000-00000000000a','f4444444-4444-4444-8444-444444444444','viewer'),
 ('f4a00000-0000-4000-8000-00000000000a','f4555555-5555-4555-8555-555555555555','admin'),
 ('f4b00000-0000-4000-8000-00000000000b','f4333333-3333-4333-8333-333333333333','owner');
-- Agents: the admin's organization agent, and the org owner's organization agent.
INSERT INTO public.custom_agents (id, organization_id, owner_user_id, name, instructions, visibility) VALUES
 ('f4d00000-0000-4000-8000-000000000001','f4a00000-0000-4000-8000-00000000000a','f4555555-5555-4555-8555-555555555555','Admin bot','Admin rules.','organization'),
 ('f4d00000-0000-4000-8000-000000000002','f4a00000-0000-4000-8000-00000000000a','f4111111-1111-4111-8111-111111111111','Owner bot','Owner rules.','organization'),
 ('f4d00000-0000-4000-8000-0000000000bb','f4b00000-0000-4000-8000-00000000000b','f4333333-3333-4333-8333-333333333333','B bot','B rules.','organization');
-- 12 organization collections of the admin (readable by everyone in A), one private of the member, one in B.
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility)
  SELECT ('f4c00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'f4a00000-0000-4000-8000-00000000000a',
         'f4555555-5555-4555-8555-555555555555', 'Shared ' || i, 'organization' FROM generate_series(1, 12) i;
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility) VALUES
 ('f4c00000-0000-4000-8000-0000000000a1','f4a00000-0000-4000-8000-00000000000a','f4222222-2222-4222-8222-222222222222','Member private','private'),
 ('f4c00000-0000-4000-8000-0000000000b1','f4b00000-0000-4000-8000-00000000000b','f4333333-3333-4333-8333-333333333333','B','organization');
-- A pre-existing link on the org owner's agent (to test that an admin cannot remove it).
INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES
 ('f4d00000-0000-4000-8000-000000000002','f4c00000-0000-4000-8000-000000000012','f4a00000-0000-4000-8000-00000000000a','f4111111-1111-4111-8111-111111111111');


SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f4555555-5555-4555-8555-555555555555","role":"authenticated"}',true);
SELECT lives_ok($$UPDATE public.custom_agents SET name='Admin owns org' WHERE id='f4d00000-0000-4000-8000-000000000001'$$, 'admin owner can update organization agent');
SELECT lives_ok($$INSERT INTO public.custom_agents(id,organization_id,owner_user_id,name,instructions,visibility) VALUES('f4d00000-0000-4000-8000-000000000004','f4a00000-0000-4000-8000-00000000000a','f4555555-5555-4555-8555-555555555555','Private','Retained','private')$$, 'admin owner creates private agent');
RESET ROLE;
UPDATE public.organization_members SET role='manager' WHERE user_id='f4555555-5555-4555-8555-555555555555';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$UPDATE public.custom_agents SET name='Denied' WHERE id='f4d00000-0000-4000-8000-000000000001'$$,'42501',NULL,'manager owner cannot retain organization visibility on UPDATE');
SELECT throws_ok($$SELECT public.save_custom_agent('f4a00000-0000-4000-8000-00000000000a','f4d00000-0000-4000-8000-000000000001','{"name":"Denied"}',NULL)$$,'42501',NULL,'manager ordinary RPC save is denied too');
SELECT is((SELECT name FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000001'),'Admin owns org','denied edits do not change row');
SELECT lives_ok($$UPDATE public.custom_agents SET name='Manager private' WHERE id='f4d00000-0000-4000-8000-000000000004'$$,'manager edits owned private agent');
SELECT is((SELECT name FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000004'),'Manager private','private change persisted');
SELECT throws_ok($$UPDATE public.custom_agents SET visibility='organization' WHERE id='f4d00000-0000-4000-8000-000000000004'$$,'42501',NULL,'manager cannot publish private agent');
SELECT throws_ok($$INSERT INTO public.custom_agents(organization_id,owner_user_id,name,visibility) VALUES('f4a00000-0000-4000-8000-00000000000a','f4555555-5555-4555-8555-555555555555','Denied org','organization')$$,'42501',NULL,'manager cannot create organization agent');
UPDATE public.custom_agents SET name='Hijacked' WHERE id='f4d00000-0000-4000-8000-000000000002';
SELECT is((SELECT name FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000002'),'Owner bot','manager cannot update other-owner agent');
DELETE FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000002';
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000002'),1,'manager has no foreign moderation delete');
SELECT lives_ok($$SELECT public.link_custom_agent_collection('f4a00000-0000-4000-8000-00000000000a','f4d00000-0000-4000-8000-000000000001','f4c00000-0000-4000-8000-000000000001')$$,'knowledge link remains governed by ownership not resulting agent visibility');
RESET ROLE;
UPDATE public.organization_members SET role='viewer' WHERE user_id='f4555555-5555-4555-8555-555555555555';
SET LOCAL ROLE authenticated;
UPDATE public.custom_agents SET name='Viewer denied' WHERE id='f4d00000-0000-4000-8000-000000000004';
SELECT is((SELECT name FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000004'),'Manager private','viewer owner cannot edit private agent');
UPDATE public.custom_agents SET visibility='private' WHERE id='f4d00000-0000-4000-8000-000000000001';
SELECT is((SELECT visibility FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000001'),'organization','viewer owner cannot privatize organization agent');
DELETE FROM public.custom_agents WHERE id IN ('f4d00000-0000-4000-8000-000000000001','f4d00000-0000-4000-8000-000000000004');
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE id IN ('f4d00000-0000-4000-8000-000000000001','f4d00000-0000-4000-8000-000000000004')),2,'viewer owner cannot delete either visibility');
SELECT throws_ok($$INSERT INTO public.custom_agents(organization_id,owner_user_id,name) VALUES('f4a00000-0000-4000-8000-00000000000a','f4555555-5555-4555-8555-555555555555','Viewer denied')$$,'42501',NULL,'viewer cannot create private agent');
RESET ROLE;
UPDATE public.organization_members SET role='manager' WHERE user_id='f4555555-5555-4555-8555-555555555555';
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.save_custom_agent('f4a00000-0000-4000-8000-00000000000a','f4d00000-0000-4000-8000-000000000001','{"visibility":"private"}',NULL)$$,'manager owner may explicitly reduce visibility');
SELECT is((SELECT visibility FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000001'),'private','explicit privatization persisted');
RESET ROLE;
UPDATE public.organization_members SET role='admin' WHERE user_id='f4555555-5555-4555-8555-555555555555';
SET LOCAL ROLE authenticated;
UPDATE public.custom_agents SET name='Admin hijacked' WHERE id='f4d00000-0000-4000-8000-000000000002';
SELECT is((SELECT name FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000002'),'Owner bot','admin still cannot edit a foreign-owned agent');
DELETE FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000002';
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-000000000002'),0,'admin moderation deletion remains allowed');
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE id='f4d00000-0000-4000-8000-0000000000bb'),0,'cross-tenant agent remains invisible');
SELECT * FROM finish();
ROLLBACK;
