-- workspace_agent_save.test.sql — 20261120100008: save_custom_agent(), the
-- atomic C-1 save (fields + collectionIds in one statement). Owner-only
-- edits, RLS-checked collection access, links the caller cannot see are
-- preserved, version bump, atomic rollback, cross-tenant rejection.
BEGIN;
SELECT plan(30);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','eb111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_as_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','eb222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_as_member_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','eb444444-4444-4444-8444-444444444444','authenticated','authenticated','ws_as_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','eb555555-5555-4555-8555-555555555555','authenticated','authenticated','ws_as_admin_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','eb333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_as_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('eba00000-0000-4000-8000-00000000000a','Save A','ws-as-a'), ('ebb00000-0000-4000-8000-00000000000b','Save B','ws-as-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','owner'),
 ('eba00000-0000-4000-8000-00000000000a','eb222222-2222-4222-8222-222222222222','agent'),
 ('eba00000-0000-4000-8000-00000000000a','eb444444-4444-4444-8444-444444444444','viewer'),
 ('eba00000-0000-4000-8000-00000000000a','eb555555-5555-4555-8555-555555555555','admin'),
 ('ebb00000-0000-4000-8000-00000000000b','eb333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility) VALUES
 ('ebc00000-0000-4000-8000-000000000001','eba00000-0000-4000-8000-00000000000a','eb222222-2222-4222-8222-222222222222','Member private','private'),
 ('ebc00000-0000-4000-8000-000000000002','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','Owner private','private'),
 ('ebc00000-0000-4000-8000-000000000003','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','Company','organization'),
 ('ebc00000-0000-4000-8000-000000000005','eba00000-0000-4000-8000-00000000000a','eb555555-5555-4555-8555-555555555555','Admin private','private'),
 ('ebc00000-0000-4000-8000-000000000006','eba00000-0000-4000-8000-00000000000a','eb111111-1111-4111-8111-111111111111','Company 2','organization'),
 ('ebc00000-0000-4000-8000-0000000000bb','ebb00000-0000-4000-8000-00000000000b','eb333333-3333-4333-8333-333333333333','B','organization');
INSERT INTO public.knowledge_collections (id, organization_id, owner_user_id, name, visibility)
  SELECT ('ebe00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'eba00000-0000-4000-8000-00000000000a',
         'eb555555-5555-4555-8555-555555555555', 'Admin hidden ' || i, 'private' FROM generate_series(1, 18) i;

SELECT ok((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc p
  WHERE p.oid = 'public.save_custom_agent(uuid,uuid,jsonb,uuid[])'::regprocedure), 'SECURITY INVOKER with a pinned search_path'); -- 1
SELECT ok(NOT has_function_privilege('anon','public.save_custom_agent(uuid,uuid,jsonb,uuid[])','EXECUTE')
  AND has_function_privilege('authenticated','public.save_custom_agent(uuid,uuid,jsonb,uuid[])','EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = 'public.save_custom_agent(uuid,uuid,jsonb,uuid[])'::regprocedure
                  AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'), 'anon and PUBLIC cannot execute; authenticated can'); -- 2

-- Member (role agent) ------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"eb222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT lives_ok($$SELECT set_config('t.m', public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL,
  '{"name":"Travel","instructions":"Answer travel questions.","model_key":null,"tools":[],"conversation_starters":["Hotel limit?"]}',
  ARRAY['ebc00000-0000-4000-8000-000000000001','ebc00000-0000-4000-8000-000000000003']::uuid[])::text, true)$$, 'member creates a private agent with knowledge'); -- 3
SELECT results_eq($$SELECT collection_id FROM public.custom_agent_collections WHERE agent_id = current_setting('t.m')::uuid ORDER BY 1$$,
  $$VALUES ('ebc00000-0000-4000-8000-000000000001'::uuid), ('ebc00000-0000-4000-8000-000000000003'::uuid)$$, 'links created with the agent'); -- 4
SELECT is((SELECT row(a.name, a.visibility, a.conversation_starters, a.owner_user_id)::text FROM public.custom_agents a WHERE a.id = current_setting('t.m')::uuid),
  row('Travel', 'private', ARRAY['Hotel limit?'], 'eb222222-2222-4222-8222-222222222222'::uuid)::text, 'fields stored, private by default, owned by the caller'); -- 5
SELECT set_config('t.v', (SELECT version::text FROM public.custom_agents WHERE id = current_setting('t.m')::uuid), true);

SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"Org","instructions":"x","visibility":"organization"}')$$,
  '42501', NULL, 'members cannot publish to the organization'); -- 6
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x"}', ARRAY['ebc00000-0000-4000-8000-000000000002']::uuid[])$$,
  '22023', 'INVALID_COLLECTION', 'another user''s private collection is rejected'); -- 7
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x"}', ARRAY['ebc00000-0000-4000-8000-0000000000bb']::uuid[])$$,
  '22023', 'INVALID_COLLECTION', 'a collection from another organization is rejected'); -- 8
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x"}', ARRAY['ebc00000-0000-4000-8000-0000000000ff']::uuid[])$$,
  '22023', 'INVALID_COLLECTION', 'an unknown collection is rejected'); -- 9
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x"}',
  (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 11)))$$, '22023', 'TOO_MANY_COLLECTIONS', 'more than 10 collections are rejected'); -- 10
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x"}', ARRAY[NULL]::uuid[])$$,
  '22023', 'INVALID_REQUEST', 'NULL collection ids are rejected'); -- 11
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x","owner_user_id":"eb111111-1111-4111-8111-111111111111"}')$$,
  '22023', 'INVALID_REQUEST', 'identity columns cannot be passed in'); -- 12
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"X","instructions":"x","conversation_starters":"hi"}')$$,
  '22023', 'INVALID_REQUEST', 'starters must be an array'); -- 13
SELECT is((SELECT count(*)::int FROM public.custom_agents WHERE name = 'X'), 0, 'no rejected create left a row'); -- 14

SELECT is(public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', current_setting('t.m')::uuid, '{"name":"Travel 2"}',
  ARRAY['ebc00000-0000-4000-8000-000000000003']::uuid[]), current_setting('t.m')::uuid, 'owner update returns the agent id'); -- 15
SELECT is((SELECT row(name, instructions, version - current_setting('t.v')::int)::text FROM public.custom_agents WHERE id = current_setting('t.m')::uuid),
  row('Travel 2', 'Answer travel questions.', 1)::text, 'absent keys are kept and the version is bumped once'); -- 16
SELECT results_eq($$SELECT collection_id FROM public.custom_agent_collections WHERE agent_id = current_setting('t.m')::uuid$$,
  $$VALUES ('ebc00000-0000-4000-8000-000000000003'::uuid)$$, 'collectionIds replace the visible links'); -- 17
SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', current_setting('t.m')::uuid, '{"description":"d"}');
SELECT is((SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = current_setting('t.m')::uuid), 1, 'NULL collectionIds leave links alone'); -- 18
SELECT throws_ok($$SELECT public.save_custom_agent('ebb00000-0000-4000-8000-00000000000b', NULL, '{"name":"Y","instructions":"x"}')$$,
  '42501', NULL, 'cannot create in another organization'); -- 19
SELECT throws_ok(format($$SELECT public.save_custom_agent('ebb00000-0000-4000-8000-00000000000b', %L, '{"name":"Y"}')$$, current_setting('t.m')),
  'P0002', 'NOT_FOUND', 'an agent cannot be saved through another organization id'); -- 20

-- Org owner ----------------------------------------------------------------
SELECT set_config('request.jwt.claims','{"sub":"eb111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT throws_ok(format($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', %L, '{"name":"Hijack"}')$$, current_setting('t.m')),
  'P0002', 'NOT_FOUND', 'org owner cannot edit a member''s private agent'); -- 21
SELECT set_config('t.o', public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL,
  '{"name":"Company bot","instructions":"Company policy.","visibility":"organization"}',
  ARRAY['ebc00000-0000-4000-8000-000000000002','ebc00000-0000-4000-8000-000000000003']::uuid[])::text, true);

-- Org admin: can read the org agent, cannot save it; links a private collection (RLS allows it).
SELECT set_config('request.jwt.claims','{"sub":"eb555555-5555-4555-8555-555555555555","role":"authenticated"}',true);
SELECT throws_ok(format($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', %L, '{"name":"Admin edit"}')$$, current_setting('t.o')),
  'P0002', 'NOT_FOUND', 'org admin cannot edit someone else''s organization agent (C-1 owner-only)'); -- 22
SELECT lives_ok(format($$INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by)
  VALUES (%L, 'ebc00000-0000-4000-8000-000000000005', 'eba00000-0000-4000-8000-00000000000a', 'eb555555-5555-4555-8555-555555555555')$$, current_setting('t.o')),
  'admin links a collection the owner cannot read'); -- 23

-- Owner saves again: the admin's hidden link survives, unwanted visible links go.
SELECT set_config('request.jwt.claims','{"sub":"eb111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', current_setting('t.o')::uuid, '{}', ARRAY['ebc00000-0000-4000-8000-000000000003']::uuid[]);
RESET ROLE;
SELECT results_eq(format($$SELECT collection_id FROM public.custom_agent_collections WHERE agent_id = %L ORDER BY 1$$, current_setting('t.o')),
  $$VALUES ('ebc00000-0000-4000-8000-000000000003'::uuid), ('ebc00000-0000-4000-8000-000000000005'::uuid)$$, 'hidden link kept, unwanted visible link removed'); -- 24
SET LOCAL ROLE authenticated;
SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', current_setting('t.o')::uuid, '{}', ARRAY[]::uuid[]);
RESET ROLE;
SELECT results_eq(format($$SELECT collection_id FROM public.custom_agent_collections WHERE agent_id = %L$$, current_setting('t.o')),
  $$VALUES ('ebc00000-0000-4000-8000-000000000005'::uuid)$$, 'an empty list clears only the visible links'); -- 25

-- Atomicity: 18 more hidden links (19 total); adding two visible ones hits the 20-link trigger cap.
INSERT INTO public.custom_agent_collections (agent_id, collection_id, organization_id, linked_by)
  SELECT current_setting('t.o')::uuid, ('ebe00000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
         'eba00000-0000-4000-8000-00000000000a', 'eb555555-5555-4555-8555-555555555555' FROM generate_series(1, 18) i;
SET LOCAL ROLE authenticated;
SELECT set_config('t.v', (SELECT version::text FROM public.custom_agents WHERE id = current_setting('t.o')::uuid), true);
SELECT throws_ok(format($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', %L, '{"name":"Renamed"}',
  ARRAY['ebc00000-0000-4000-8000-000000000003','ebc00000-0000-4000-8000-000000000006']::uuid[])$$, current_setting('t.o')),
  '22023', 'TOO_MANY_COLLECTIONS', 'the total link cap (hidden links included) still applies'); -- 26
SELECT is((SELECT row(name, version - current_setting('t.v')::int)::text FROM public.custom_agents WHERE id = current_setting('t.o')::uuid),
  row('Company bot', 0)::text, 'a failed save rolls back the field change and the version bump'); -- 27
SELECT is((SELECT count(*)::int FROM public.custom_agent_collections WHERE agent_id = current_setting('t.o')::uuid), 19, 'and inserts no links'); -- 28

-- Viewer, and an owner demoted to viewer.
SELECT set_config('request.jwt.claims','{"sub":"eb444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', NULL, '{"name":"V","instructions":"x"}')$$,
  '42501', NULL, 'viewers cannot create agents'); -- 29
RESET ROLE;
UPDATE public.organization_members SET role = 'viewer' WHERE organization_id = 'eba00000-0000-4000-8000-00000000000a' AND user_id = 'eb222222-2222-4222-8222-222222222222';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"eb222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT throws_ok(format($$SELECT public.save_custom_agent('eba00000-0000-4000-8000-00000000000a', %L, '{"name":"Demoted"}')$$, current_setting('t.m')),
  'P0002', 'NOT_FOUND', 'an owner demoted to viewer can no longer save their agent (FOR UPDATE applies the UPDATE policy)'); -- 30

SELECT * FROM finish();
ROLLBACK;
