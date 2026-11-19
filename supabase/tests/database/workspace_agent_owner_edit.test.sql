-- workspace_agent_owner_edit.test.sql — 20261120100009: editing a custom agent
-- (fields and knowledge links) is owner-only in the database, as in the API;
-- deleting stays owner-or-admin. link_custom_agent_collection(): owner-only,
-- readable collections only, idempotent, at most 10 visible links per agent.
BEGIN;
SELECT plan(26);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e9111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_oe_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e9222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_oe_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e9444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_oe_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e9555555-5555-4555-8555-555555555555','authenticated','authenticated','ws_oe_admin_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e9333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_oe_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('e9a00000-0000-4000-8000-00000000000a','OwnerEdit A','ws-oe-a'), ('e9b00000-0000-4000-8000-00000000000b','OwnerEdit B','ws-oe-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e9a00000-0000-4000-8000-00000000000a','e9111111-1111-4111-8111-111111111111','owner'),
 ('e9a00000-0000-4000-8000-00000000000a','e9222222-2222-4222-8222-222222222222','agent'),
 ('e9a00000-0000-4000-8000-00000000000a','e9444444-4444-4444-8444-444444444444','viewer'),
 ('e9a00000-0000-4000-8000-00000000000a','e9555555-5555-4555-8555-555555555555','admin'),
 ('e9b00000-0000-4000-8000-00000000000b','e9333333-3333-4333-8333-333333333333','owner');
-- Agents: the admin's organization agent, and the org owner's organization agent.
INSERT INTO public.custom_agents (id, organization_id, owner_user_id, name, instructions, visibility) VALUES
 ('e9d00000-0000-4000-8000-000000000001','e9a00000-0000-4000-8000-00000000000a','e9555555-5555-4555-8555-555555555555','Admin bot','Admin rules.','organization'),
 ('e9d00000-0000-4000-8000-000000000002','e9a00000-0000-4000-8000-00000000000a','e9111111-1111-4111-8111-111111111111','Owner bot','Owner rules.','organization'),
 ('e9d00000-0000-4000-8000-0000000000bb','e9b00000-0000-4000-8000-00000000000b','e9333333-3333-4333-8333-333333333333','B bot','B rules.','organization');
-- 12 organization collections of the admin (readable by everyone in A), one private of the member, one in B.
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility)
  SELECT ('e9c00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'e9a00000-0000-4000-8000-00000000000a',
         'e9555555-5555-4555-8555-555555555555', 'Shared ' || i, 'organization' FROM generate_series(1, 12) i;
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility) VALUES
 ('e9c00000-0000-4000-8000-0000000000a1','e9a00000-0000-4000-8000-00000000000a','e9222222-2222-4222-8222-222222222222','Member private','private'),
 ('e9c00000-0000-4000-8000-0000000000b1','e9b00000-0000-4000-8000-00000000000b','e9333333-3333-4333-8333-333333333333','B','organization');
-- A pre-existing link on the org owner's agent (to test that an admin cannot remove it).
INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by) VALUES
 ('e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000012','e9a00000-0000-4000-8000-00000000000a','e9111111-1111-4111-8111-111111111111');

SELECT ok((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc p
  WHERE p.oid = 'private.can_edit_agent(uuid,uuid)'::regprocedure), 'can_edit_agent: SECURITY DEFINER, pinned search_path'); -- 1
SELECT ok((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc p
  WHERE p.oid = 'public.link_custom_agent_collection(uuid,uuid,uuid)'::regprocedure), 'link function: SECURITY INVOKER, pinned search_path'); -- 2
SELECT ok(NOT has_function_privilege('anon','public.link_custom_agent_collection(uuid,uuid,uuid)','EXECUTE')
  AND has_function_privilege('authenticated','public.link_custom_agent_collection(uuid,uuid,uuid)','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = 'public.link_custom_agent_collection(uuid,uuid,uuid)'::regprocedure
                  AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'), 'link function: anon and PUBLIC cannot execute; authenticated can'); -- 3

SET LOCAL ROLE authenticated;

-- Org owner vs the admin's agent, admin vs the org owner's agent: neither may edit.
SELECT set_config('request.jwt.claims','{"sub":"e9111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
UPDATE public.custom_agents SET instructions = 'Hijacked by owner' WHERE id = 'e9d00000-0000-4000-8000-000000000001';
SELECT set_config('request.jwt.claims','{"sub":"e9555555-5555-4555-8555-555555555555","role":"authenticated"}',true);
UPDATE public.custom_agents SET instructions = 'Hijacked by admin' WHERE id = 'e9d00000-0000-4000-8000-000000000002';
DELETE FROM public.custom_agent_collections WHERE agent_id = 'e9d00000-0000-4000-8000-000000000002';
SELECT throws_ok($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by)
  VALUES ('e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000001','e9a00000-0000-4000-8000-00000000000a','e9555555-5555-4555-8555-555555555555')$$,
  '42501', NULL, 'admin cannot insert a link into another member''s agent'); -- 4
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000001')$$,
  'P0002', 'AGENT_NOT_FOUND', 'admin cannot link through the function either'); -- 5
-- The admin owns agent 1 and may edit it.
UPDATE public.custom_agents SET description = 'Edited by its owner' WHERE id = 'e9d00000-0000-4000-8000-000000000001';
RESET ROLE;
SELECT is((SELECT instructions FROM public.custom_agents WHERE id = 'e9d00000-0000-4000-8000-000000000001'), 'Admin rules.', 'org owner cannot rewrite the admin''s agent'); -- 6
SELECT is((SELECT instructions FROM public.custom_agents WHERE id = 'e9d00000-0000-4000-8000-000000000002'), 'Owner rules.', 'admin cannot rewrite the org owner''s agent'); -- 7
SELECT results_eq($$SELECT collection_id FROM public.custom_agent_collections WHERE agent_id = 'e9d00000-0000-4000-8000-000000000002'$$,
  $$VALUES ('e9c00000-0000-4000-8000-000000000012'::uuid)$$, 'admin cannot remove (or add) another member''s links'); -- 8
SELECT is((SELECT description FROM public.custom_agents WHERE id = 'e9d00000-0000-4000-8000-000000000001'), 'Edited by its owner', 'an owner still edits their own agent'); -- 9
SET LOCAL ROLE authenticated;

-- The link function, as the org owner on their own agent.
SELECT set_config('request.jwt.claims','{"sub":"e9111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is(public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000001'),
  true, 'owner links a readable collection'); -- 10
SELECT is(public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000001'),
  false, 'linking again is a no-op'); -- 11
SELECT is((SELECT linked_by FROM public.custom_agent_collections WHERE agent_id = 'e9d00000-0000-4000-8000-000000000002' AND collection_id = 'e9c00000-0000-4000-8000-000000000001'),
  'e9111111-1111-4111-8111-111111111111'::uuid, 'linked_by is the caller'); -- 12
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-0000000000a1')$$,
  'P0002', 'COLLECTION_NOT_FOUND', 'a collection the caller cannot read is not found'); -- 13
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-0000000000b1')$$,
  'P0002', 'COLLECTION_NOT_FOUND', 'another tenant''s collection is not found'); -- 14
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-0000000000bb','e9c00000-0000-4000-8000-000000000002')$$,
  'P0002', 'AGENT_NOT_FOUND', 'another tenant''s agent is not found'); -- 15
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9b00000-0000-4000-8000-00000000000b','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000002')$$,
  'P0002', 'AGENT_NOT_FOUND', 'an agent cannot be addressed through another organization id'); -- 16
-- Up to 10 visible links: 2 exist (12, 1), add 3..10 -> 10.
SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002',
  ('e9c00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid) FROM generate_series(3, 10) i;
SELECT is((SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = 'e9d00000-0000-4000-8000-000000000002'), 10, 'ten links'); -- 17
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000011')$$,
  '22023', 'TOO_MANY_COLLECTIONS', 'the eleventh visible link is refused'); -- 18
SELECT is(public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000010'),
  false, 'at the limit, re-linking an existing collection is still a no-op, not an error'); -- 19
-- A link that becomes hidden (the admin makes collection 10 private) no longer counts toward the 10.
RESET ROLE;
UPDATE public.knowledge_collections SET visibility = 'private' WHERE id = 'e9c00000-0000-4000-8000-000000000010';
SET LOCAL ROLE authenticated;
SELECT is(public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000011'),
  true, 'hidden links do not count toward the visible limit'); -- 20
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = 'e9d00000-0000-4000-8000-000000000002'), 11,
  'the hidden link itself is kept (the 20-row database cap still bounds the total)'); -- 21
SET LOCAL ROLE authenticated;

-- Viewers and anonymous callers.
SELECT set_config('request.jwt.claims','{"sub":"e9444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000012')$$,
  'P0002', 'AGENT_NOT_FOUND', 'a viewer cannot link'); -- 22
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000002','e9c00000-0000-4000-8000-000000000012')$$,
  '42501', 'FORBIDDEN', 'no user, no link'); -- 23
-- An owner demoted to viewer loses edit rights on their own agent.
RESET ROLE;
UPDATE public.organization_members SET role = 'viewer' WHERE organization_id = 'e9a00000-0000-4000-8000-00000000000a' AND user_id = 'e9555555-5555-4555-8555-555555555555';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e9555555-5555-4555-8555-555555555555","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.link_custom_agent_collection('e9a00000-0000-4000-8000-00000000000a','e9d00000-0000-4000-8000-000000000001','e9c00000-0000-4000-8000-000000000001')$$,
  'P0002', 'AGENT_NOT_FOUND', 'an owner demoted to viewer cannot link to their own agent'); -- 24
RESET ROLE;
UPDATE public.organization_members SET role = 'admin' WHERE organization_id = 'e9a00000-0000-4000-8000-00000000000a' AND user_id = 'e9555555-5555-4555-8555-555555555555';
SET LOCAL ROLE authenticated;

-- Moderation is unchanged: an admin may delete (not edit) an organization agent.
SELECT set_config('request.jwt.claims','{"sub":"e9555555-5555-4555-8555-555555555555","role":"authenticated"}',true);
DELETE FROM public.custom_agents WHERE id = 'e9d00000-0000-4000-8000-000000000002';
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE id = 'e9d00000-0000-4000-8000-000000000002'), 0, 'admin can still delete an organization agent'); -- 25
SELECT is((SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = 'e9d00000-0000-4000-8000-000000000002'), 0, 'and its links go with it'); -- 26

SELECT * FROM finish();
ROLLBACK;
