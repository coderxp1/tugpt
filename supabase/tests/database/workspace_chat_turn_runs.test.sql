-- workspace_chat_turn_runs.test.sql — 20261122100001 (Q-13): one model run per chat turn.
-- A live lease blocks a second claim ('busy'); an expired one is taken over; a claim made on an
-- outdated view of the turn is undone ('stale'); only the latest user turn can be retried
-- ('not_latest'); release needs the run token, the owner and the tenant; clients can read their
-- own runs (never the token) and write nothing; nothing crosses users or tenants.
BEGIN;
SELECT plan(30);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e7111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_run_a1@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_run_a2@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_run_b1@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','Runs A','ws-run-a'), ('e7b00000-0000-4000-8000-00000000000b','Runs B','ws-run-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','agent'),
 ('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','agent'),
 ('e7b00000-0000-4000-8000-00000000000b','e7333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('e7700000-0000-4000-8000-0000000000a1','e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','A1 first','it-model'),
 ('e7700000-0000-4000-8000-0000000000a3','e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','A1 second','it-model'),
 ('e7700000-0000-4000-8000-0000000000a2','e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','A2','it-model'),
 ('e7700000-0000-4000-8000-0000000000b1','e7b00000-0000-4000-8000-00000000000b','e7333333-3333-4333-8333-333333333333','B1','it-model');


-- Deterministic history (explicit created_at; inside one transaction now() is constant).
INSERT INTO public.chat_messages (id, organization_id, thread_id, role, content, status, turn_id, created_at) VALUES
 ('e7e00000-0000-4000-8000-000000000001','e7a00000-0000-4000-8000-00000000000a','e7700000-0000-4000-8000-0000000000a1','user','first question','complete','e7f00000-0000-4000-8000-000000000001', now() - interval '10 minutes'),
 ('e7e00000-0000-4000-8000-000000000002','e7a00000-0000-4000-8000-00000000000a','e7700000-0000-4000-8000-0000000000a1','assistant','failed','error','e7f00000-0000-4000-8000-000000000001', now() - interval '9 minutes'),
 ('e7e00000-0000-4000-8000-000000000003','e7a00000-0000-4000-8000-00000000000a','e7700000-0000-4000-8000-0000000000a1','user','second question','complete','e7f00000-0000-4000-8000-000000000002', now() - interval '8 minutes'),
 ('e7e00000-0000-4000-8000-000000000004','e7a00000-0000-4000-8000-00000000000a','e7700000-0000-4000-8000-0000000000a1','assistant','failed again','error','e7f00000-0000-4000-8000-000000000002', now() - interval '7 minutes'),
 ('e7e00000-0000-4000-8000-000000000005','e7a00000-0000-4000-8000-00000000000a','e7700000-0000-4000-8000-0000000000a3','user','fresh question','complete','e7f00000-0000-4000-8000-000000000003', now() - interval '1 minute');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key, archived_at) VALUES
 ('e7700000-0000-4000-8000-0000000000a9','e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','archived','it-model', now());
INSERT INTO public.chat_messages (organization_id, thread_id, role, content, status, turn_id) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','e7700000-0000-4000-8000-0000000000a9','user','old','complete','e7f00000-0000-4000-8000-0000000000ff');

CREATE FUNCTION pg_temp.claim(p_org uuid, p_user uuid, p_thread uuid, p_turn uuid, p_expected uuid,
  p_latest boolean DEFAULT true, p_ttl integer DEFAULT 150) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v jsonb;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.claim_chat_turn_run_server(p_org, p_user, p_thread, p_turn, p_expected, p_latest, p_ttl);
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.release(p_org uuid, p_user uuid, p_thread uuid, p_turn uuid, p_run uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v boolean;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.release_chat_turn_run_server(p_org, p_user, p_thread, p_turn, p_run);
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.as_user(p_sub text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;


-- Schema and grants.
SELECT has_table('public', 'chat_turn_runs', 'chat_turn_runs exists'); -- 1
SELECT ok((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.chat_turn_runs'::regclass), 'RLS enabled and forced'); -- 2
SELECT ok(NOT has_table_privilege('authenticated', 'public.chat_turn_runs', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.chat_turn_runs', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.chat_turn_runs', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.chat_turn_runs', 'SELECT'), 'clients write nothing; anon reads nothing'); -- 3
SELECT ok(has_column_privilege('authenticated', 'public.chat_turn_runs', 'expires_at', 'SELECT')
  AND NOT has_column_privilege('authenticated', 'public.chat_turn_runs', 'run_id', 'SELECT')
  AND NOT has_column_privilege('authenticated', 'public.chat_turn_runs', 'user_id', 'SELECT'), 'owner reads status columns, never the run token'); -- 4
SELECT ok((SELECT bool_and(prosecdef AND provolatile = 'v' AND proconfig @> ARRAY['search_path=pg_catalog']) FROM pg_proc
  WHERE oid IN ('public.claim_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid,boolean,integer)'::regprocedure, 'public.release_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid)'::regprocedure)),
  'claim/release: SECURITY DEFINER, VOLATILE, pinned search_path'); -- 5
SELECT ok(has_function_privilege('sso_control', 'public.claim_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid,boolean,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.claim_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid,boolean,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid,boolean,integer)', 'EXECUTE'), 'claim: sso_control only'); -- 6
SELECT ok(has_function_privilege('sso_control', 'public.release_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.release_chat_turn_run_server(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE'), 'release: sso_control only'); -- 7

-- One live run per turn.
CREATE TEMP TABLE r AS SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002','e7e00000-0000-4000-8000-000000000004') AS v;
SELECT is((SELECT v->>'outcome' FROM r), 'claimed', 'a retry of the latest failed turn takes the lease'); -- 8
SELECT is(pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002','e7e00000-0000-4000-8000-000000000004')->>'outcome', 'busy', 'a second concurrent retry is refused (busy)'); -- 9
SELECT is((SELECT count(*)::int FROM public.chat_turn_runs WHERE turn_id = 'e7f00000-0000-4000-8000-000000000002'), 1, 'still exactly one run'); -- 10

-- Visibility.
SELECT pg_temp.as_user('e7111111-1111-4111-8111-111111111111');
SELECT is((SELECT count(*)::int FROM public.chat_turn_runs WHERE thread_id = 'e7700000-0000-4000-8000-0000000000a1' AND expires_at > now()), 1, 'the owner sees their live run'); -- 11
SELECT throws_ok($$SELECT run_id FROM public.chat_turn_runs$$, '42501', NULL, 'the owner cannot read the run token'); -- 12
SELECT throws_ok($$INSERT INTO public.chat_turn_runs (thread_id, turn_id, organization_id, user_id, expires_at)
  VALUES ('e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000001','e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111', now() + interval '1 hour')$$, '42501', NULL, 'the owner cannot write a run'); -- 13
SELECT throws_ok($$SELECT public.claim_chat_turn_run_server('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002', NULL, true, 150)$$, '42501', NULL, 'the owner cannot call claim directly'); -- 14
RESET role;
SELECT pg_temp.as_user('e7222222-2222-4222-8222-222222222222');
SELECT is((SELECT count(*)::int FROM public.chat_turn_runs), 0, 'a colleague in the same tenant sees no runs'); -- 15
RESET role;
SELECT pg_temp.as_user('e7333333-3333-4333-8333-333333333333');
SELECT is((SELECT count(*)::int FROM public.chat_turn_runs), 0, 'another tenant sees no runs'); -- 16
RESET role;

-- Release needs the token, the owner and the tenant.
SELECT is(pg_temp.release('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002', gen_random_uuid()), false, 'a wrong run token releases nothing'); -- 17
SELECT is(pg_temp.release('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002', (SELECT (v->>'run_id')::uuid FROM r)), false, 'another user cannot release it'); -- 18
SELECT is(pg_temp.release('e7b00000-0000-4000-8000-00000000000b','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002', (SELECT (v->>'run_id')::uuid FROM r)), false, 'another tenant cannot release it'); -- 19
SELECT is(pg_temp.release('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002', (SELECT (v->>'run_id')::uuid FROM r)), true, 'the holder releases it'); -- 20

-- Outdated view of the turn, not the latest turn.
SELECT is(pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002', NULL)->>'outcome', 'stale', 'a claim that did not see the latest answer is stale'); -- 21
SELECT is(pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000001','e7e00000-0000-4000-8000-000000000002')->>'outcome', 'not_latest', 'an older turn cannot be retried'); -- 22
SELECT is((SELECT count(*)::int FROM public.chat_turn_runs WHERE thread_id = 'e7700000-0000-4000-8000-0000000000a1'), 0, 'refused claims leave no run behind'); -- 23

-- Fresh turn (no answer yet), expiry and takeover.
CREATE TEMP TABLE f AS SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a3','e7f00000-0000-4000-8000-000000000003', NULL, false, 10) AS v;
SELECT is((SELECT v->>'outcome' FROM f), 'claimed', 'a fresh turn is claimed with no expected answer'); -- 24
UPDATE public.chat_turn_runs SET claimed_at = clock_timestamp() - interval '2 minutes', expires_at = clock_timestamp() - interval '1 second' WHERE turn_id = 'e7f00000-0000-4000-8000-000000000003';
SELECT ok((SELECT v->>'outcome' = 'claimed' AND v->>'run_id' <> (SELECT v->>'run_id' FROM f) FROM (SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a3','e7f00000-0000-4000-8000-000000000003', NULL, false) AS v) x),
  'an expired lease is taken over with a new token'); -- 25

-- Refusals: unknown turn, wrong owner, wrong tenant, archived thread, bad ttl.
SELECT throws_ok($$SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1', gen_random_uuid(), NULL)$$, 'P0002', NULL, 'a turn never opened in this thread: P0002'); -- 26
SELECT throws_ok($$SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002','e7e00000-0000-4000-8000-000000000004')$$, 'P0002', NULL, 'a colleague cannot claim the owner''s turn'); -- 27
SELECT throws_ok($$SELECT pg_temp.claim('e7b00000-0000-4000-8000-00000000000b','e7333333-3333-4333-8333-333333333333','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002','e7e00000-0000-4000-8000-000000000004')$$, 'P0002', NULL, 'another tenant cannot claim it'); -- 28
SELECT throws_ok($$SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a9','e7f00000-0000-4000-8000-0000000000ff', NULL)$$, 'P0002', NULL, 'an archived thread: P0002'); -- 29
SELECT throws_ok($$SELECT pg_temp.claim('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','e7700000-0000-4000-8000-0000000000a1','e7f00000-0000-4000-8000-000000000002','e7e00000-0000-4000-8000-000000000004', true, 5)$$, '22023', NULL, 'ttl outside 10..900 s: 22023'); -- 30

SELECT * FROM finish();
ROLLBACK;
