-- usage_accounting.test.sql — 20261121700002 (Agent 6, dashboard M2): usage & cost accounting.
-- record_chat_usage is server-only and idempotent per (org, turn, call); unknown usage is never priced;
-- estimated and actual cost are separate columns; threads never cross tenants; org_usage_report is
-- member-scoped (self) or owner/admin-scoped (organization) and never exposes provider/model/cost;
-- the old provider/model/cost summary is no longer callable by customers.
BEGIN;
SELECT plan(46);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e7111111-1111-4111-8111-111111111111','authenticated','authenticated','usage_a_owner@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7222222-2222-4222-8222-222222222222','authenticated','authenticated','usage_a_admin@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7333333-3333-4333-8333-333333333333','authenticated','authenticated','usage_a_agent@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7444444-4444-4444-8444-444444444444','authenticated','authenticated','usage_a_agent2@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e7555555-5555-4555-8555-555555555555','authenticated','authenticated','usage_b_owner@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','Usage A','usage-a'), ('e7b00000-0000-4000-8000-00000000000b','Usage B','usage-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e7a00000-0000-4000-8000-00000000000a','e7111111-1111-4111-8111-111111111111','owner'),
 ('e7a00000-0000-4000-8000-00000000000a','e7222222-2222-4222-8222-222222222222','admin'),
 ('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333','agent'),
 ('e7a00000-0000-4000-8000-00000000000a','e7444444-4444-4444-8444-444444444444','agent'),
 ('e7b00000-0000-4000-8000-00000000000b','e7555555-5555-4555-8555-555555555555','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('e7700000-0000-4000-8000-0000000000a3','e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333','A3','it-model'),
 ('e7700000-0000-4000-8000-0000000000a4','e7a00000-0000-4000-8000-00000000000a','e7444444-4444-4444-8444-444444444444','A4','it-model'),
 ('e7700000-0000-4000-8000-0000000000b5','e7b00000-0000-4000-8000-00000000000b','e7555555-5555-4555-8555-555555555555','B5','it-model');
INSERT INTO public.provider_prices (provider, model, dimension, unit_price, currency, effective_from, source) VALUES
 ('it-prov','it-model','input_tokens', 0.000002, 'USD', '2020-01-01', 'pgtap fixture price'),
 ('it-prov','it-model','output_tokens',0.000008, 'USD', '2020-01-01', 'pgtap fixture price');

CREATE FUNCTION pg_temp.rec(p_org uuid, p_user uuid, p_thread uuid, p_turn uuid, p_idx int,
  p_basis text DEFAULT 'reported', p_outcome text DEFAULT 'succeeded',
  p_in bigint DEFAULT 120, p_out bigint DEFAULT 30, p_feature text DEFAULT 'chat',
  p_provider text DEFAULT 'it-prov') RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v jsonb;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.record_chat_usage(p_org, p_user, p_thread, p_turn, p_idx, p_feature, p_provider, 'it-model',
                                p_in, p_out, p_basis, p_outcome, 'req-it');
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.as_user(p_sub text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;
CREATE FUNCTION pg_temp.rep(p_org uuid, p_scope text DEFAULT 'self', p_bucket text DEFAULT 'day',
  p_from timestamptz DEFAULT now() - interval '1 hour', p_to timestamptz DEFAULT now() + interval '1 hour')
  RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.org_usage_report(p_org, p_from, p_to, p_bucket, p_scope) $f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, sso_control;

-- Schema and grants -------------------------------------------------------------------------------
SELECT col_type_is('public', 'provider_usage_events', 'user_id', 'uuid', 'events carry the acting user'); -- 1
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
  WHERE oid = 'public.record_chat_usage(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,bigint,text,text,text)'::regprocedure),
  'recorder: SECURITY DEFINER with pinned search_path'); -- 2
SELECT ok(has_function_privilege('sso_control', 'public.record_chat_usage(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,bigint,text,text,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.record_chat_usage(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,bigint,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.record_chat_usage(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,bigint,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_chat_usage(uuid,uuid,uuid,uuid,integer,text,text,text,bigint,bigint,text,text,text)', 'EXECUTE'),
  'recorder: sso_control/service_role only'); -- 3
SELECT ok(has_function_privilege('authenticated', 'public.org_usage_report(uuid,timestamptz,timestamptz,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.org_usage_report(uuid,timestamptz,timestamptz,text,text)', 'EXECUTE'),
  'report: authenticated yes, anon no'); -- 4
SELECT ok(NOT has_function_privilege('authenticated', 'public.org_usage_summary(uuid,timestamptz,timestamptz)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.org_usage_summary(uuid,timestamptz,timestamptz)', 'EXECUTE'),
  'provider/model/cost summary: revoked from customers, kept for service_role'); -- 5
SELECT ok(NOT has_table_privilege('authenticated', 'public.provider_usage_events', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.provider_usage_components', 'SELECT'),
  'customers cannot read raw usage rows'); -- 6
SELECT ok((SELECT indisunique FROM pg_index WHERE indexrelid = 'public.provider_usage_events_idempotency'::regclass),
  'idempotency key is unique per organization'); -- 7

-- Recording ---------------------------------------------------------------------------------------
CREATE TEMP TABLE r AS SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000001',0) AS v;
SELECT is((SELECT (v->>'duplicate')::boolean FROM r), false, 'first record is new'); -- 8
SELECT is(pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000001',0, 'reported','succeeded',999,999),
  jsonb_build_object('event_id', (SELECT v->>'event_id' FROM r)::uuid, 'duplicate', true),
  'retry returns the same event as duplicate (quantities of the retry ignored)'); -- 9
SELECT is((SELECT count(*)::int FROM public.provider_usage_events
  WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:0'), 1, 'retry did not double-count'); -- 10
SELECT is((SELECT array_agg(quantity::bigint ORDER BY dimension) FROM public.provider_usage_components
  WHERE event_id = (SELECT (v->>'event_id')::uuid FROM r)), ARRAY[120,30]::bigint[], 'reported tokens stored as components'); -- 11
SELECT ok((SELECT cost_micros > 0 AND actual_cost_micros IS NULL AND usage_basis = 'reported' AND user_id = 'e7333333-3333-4333-8333-333333333333'
  AND feature = 'chat' AND chat_thread_id = 'e7700000-0000-4000-8000-0000000000a3'
  FROM public.provider_usage_events WHERE id = (SELECT (v->>'event_id')::uuid FROM r)),
  'reported usage gets an ESTIMATED cost; ACTUAL cost stays NULL'); -- 12
SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000001',1,'unavailable','failed',NULL,NULL);
SELECT ok((SELECT e.cost_micros IS NULL AND e.accounting_cost_micros IS NULL AND e.outcome = 'failed'
  AND NOT EXISTS (SELECT 1 FROM public.provider_usage_components c WHERE c.event_id = e.id AND c.cost_micros IS NOT NULL)
  FROM public.provider_usage_events e WHERE e.idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:1'),
  'unavailable usage is recorded as failed with NULL cost, never as a known zero'); -- 13
SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000001',2,'estimated','cancelled',40,10);
SELECT is((SELECT usage_basis || '/' || outcome FROM public.provider_usage_events
  WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:2'), 'estimated/cancelled', 'estimated basis kept distinct'); -- 14
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000002',0,'unavailable','failed',5,5)$$,
  'P3U01', NULL, 'unavailable usage with quantities is refused'); -- 15
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000002',0,'reported','succeeded',NULL,NULL)$$,
  'P3U01', NULL, 'reported usage without quantities is refused'); -- 16
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000002',64)$$,
  'P3U01', NULL, 'call index above 63 is refused'); -- 17
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000002',0,'reported','succeeded',1,1,'drafts')$$,
  'P3U01', NULL, 'only chat/agents features via this recorder'); -- 18
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000002',0,'reported','succeeded',1,1,'chat','Open AI')$$,
  'P3U01', NULL, 'malformed provider key is refused'); -- 19
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000b5','e7790000-0000-4000-8000-000000000003',0)$$,
  'P3U02', NULL, 'cross-tenant: org B thread cannot be billed to org A'); -- 20
SELECT throws_ok($$SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a4','e7790000-0000-4000-8000-000000000003',0)$$,
  'P3U02', NULL, 'another member''s thread cannot be attributed to this user'); -- 21
SELECT throws_ok($$SELECT pg_temp.rec('e7b00000-0000-4000-8000-00000000000b','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000b5','e7790000-0000-4000-8000-000000000003',0)$$,
  'P3U02', NULL, 'a non-member cannot be attributed in another org'); -- 22
SELECT pg_temp.as_user('e7333333-3333-4333-8333-333333333333');
SELECT throws_ok($$SELECT public.record_chat_usage('e7a00000-0000-4000-8000-00000000000a','e7333333-3333-4333-8333-333333333333',
  'e7700000-0000-4000-8000-0000000000a3','e7790000-0000-4000-8000-000000000004',0,'chat','it-prov','it-model',1,1,'reported','succeeded',NULL)$$,
  '42501', NULL, 'customers cannot record usage'); -- 23
SELECT throws_ok($$SELECT count(*) FROM public.provider_usage_events$$, '42501', NULL, 'customers cannot read usage events'); -- 24
RESET ROLE;

-- Constraints -------------------------------------------------------------------------------------
SELECT throws_ok($$UPDATE public.provider_usage_events SET actual_cost_micros = 5
  WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:0'$$, '23514', NULL, 'partial actual cost is refused'); -- 25
SELECT throws_ok($$UPDATE public.provider_usage_events SET cost_micros = 5, currency = 'USD'
  WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:1'$$, '23514', NULL, 'unavailable usage cannot be priced'); -- 26
CREATE TEMP TABLE est AS SELECT cost_micros FROM public.provider_usage_events WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:0';
UPDATE public.provider_usage_events SET actual_cost_micros = 1234, actual_cost_currency = 'USD',
  actual_cost_source = 'invoice:it-2026-11', actual_cost_recorded_at = now()
 WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:0';
SELECT ok((SELECT e.actual_cost_micros = 1234 AND e.cost_micros = est.cost_micros FROM public.provider_usage_events e, est
  WHERE e.idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:0'), 'actual cost recorded beside, not over, the estimate'); -- 27
SELECT throws_ok($$UPDATE public.provider_usage_events SET chat_thread_id = 'e7700000-0000-4000-8000-0000000000b5'
  WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000001:0'$$, '23503', NULL, 'thread reference cannot cross tenants'); -- 28

-- Report fixtures: a4 one call; B one call; one legacy (pre-M2, no user/feature) audio event in A.
SELECT pg_temp.rec('e7a00000-0000-4000-8000-00000000000a','e7444444-4444-4444-8444-444444444444',
  'e7700000-0000-4000-8000-0000000000a4','e7790000-0000-4000-8000-000000000005',0,'reported','succeeded',10,5);
SELECT pg_temp.rec('e7b00000-0000-4000-8000-00000000000b','e7555555-5555-4555-8555-555555555555',
  'e7700000-0000-4000-8000-0000000000b5','e7790000-0000-4000-8000-000000000006',0,'reported','succeeded',7000,7000);
SELECT private.record_provider_usage('e7a00000-0000-4000-8000-00000000000a','audio','it-prov','it-stt',
  '{"audio_seconds":30}'::jsonb, NULL, NULL, NULL, NULL, '{}'::jsonb);

-- Report: self scope --------------------------------------------------------------------------------
SELECT pg_temp.as_user('e7333333-3333-4333-8333-333333333333');
SELECT is((SELECT array[(v->'totals'->>'requests')::int, (v->'totals'->>'input_tokens')::int, (v->'totals'->>'output_tokens')::int]
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a') v) s), array[3,160,40],
  'self: only own calls; unavailable contributes no tokens'); -- 29
SELECT is((SELECT array[(v->'totals'->>'failed')::int, (v->'totals'->>'cancelled')::int,
  (v->'totals'->>'unmetered_requests')::int, (v->'totals'->>'estimated_usage_requests')::int]
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a') v) s), array[1,1,1,1], 'self: outcomes and usage basis counted'); -- 30
SELECT ok((SELECT v->'by_user' = 'null'::jsonb AND v->'unattributed_requests' = 'null'::jsonb
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a') v) s), 'self: no per-user breakdown'); -- 31
SELECT ok((SELECT v::text !~* 'provider|model|cost|micros|price|it-prov|it-stt|currency|fx_'
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a') v) s), 'self: no provider/model/cost in output'); -- 32
SELECT throws_ok($$SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','organization')$$, 'P3S02', NULL,
  'agent cannot read organization-wide usage'); -- 33

-- Report: organization scope -----------------------------------------------------------------------
SELECT pg_temp.as_user('e7111111-1111-4111-8111-111111111111');
SELECT is((SELECT (v->'totals'->>'requests')::int FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','organization') v) s), 5,
  'owner: whole org A, nothing from org B'); -- 34
SELECT pg_temp.as_user('e7222222-2222-4222-8222-222222222222');
SELECT ok((SELECT jsonb_array_length(v->'by_user') = 2 AND (v->>'unattributed_requests')::int = 1
  AND v->'by_feature' @> '[{"feature":"transcription","audio_seconds":30}]'::jsonb
  AND v->'by_feature' @> '[{"feature":"chat","requests":4}]'::jsonb
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','organization') v) s),
  'admin: per-user breakdown, legacy rows classified and counted as unattributed'); -- 35
SELECT ok((SELECT v::text !~* 'provider|model|cost|micros|price|it-prov|it-stt|currency|fx_'
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','organization') v) s), 'organization: no provider/model/cost in output'); -- 36
SELECT pg_temp.as_user('e7555555-5555-4555-8555-555555555555');
SELECT throws_ok($$SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','organization')$$, 'P3J02', NULL,
  'cross-tenant: org B owner cannot read org A'); -- 37
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT throws_ok($$SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a')$$, 'P3J01', NULL, 'no subject: unauthenticated'); -- 38
SELECT pg_temp.as_user('e7111111-1111-4111-8111-111111111111');
SELECT throws_ok($$SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','self','week')$$, 'P3U03', NULL, 'unknown bucket refused'); -- 39
SELECT throws_ok($$SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','self','day', now(), now())$$, 'P3J03', NULL, 'empty window refused'); -- 40
SELECT throws_ok($$SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','self','day', now() - interval '400 days', now())$$, 'P3J04', NULL,
  'window above 366 days refused'); -- 41
RESET ROLE;

-- Buckets follow the organization time zone.
UPDATE public.organizations SET time_zone = 'Pacific/Auckland' WHERE id = 'e7a00000-0000-4000-8000-00000000000a';
UPDATE public.provider_usage_events SET occurred_at = '2026-01-01T20:00:00Z'
 WHERE idempotency_key = 'chat:e7790000-0000-4000-8000-000000000005:0';
SELECT pg_temp.as_user('e7444444-4444-4444-8444-444444444444');
SELECT is((SELECT (v->>'time_zone') || ' ' || (v->'series'->0->>'bucket_start')
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','self','day','2026-01-01T00:00:00Z','2026-01-03T00:00:00Z') v) s),
  'Pacific/Auckland 2026-01-02', 'day bucket in org time zone (20:00Z = next day in Auckland)'); -- 42
SELECT is((SELECT v->'series'->0->>'bucket_start'
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','self','month','2026-01-01T00:00:00Z','2026-01-03T00:00:00Z') v) s),
  '2026-01-01', 'month bucket'); -- 43
RESET ROLE;

-- Data preservation.
UPDATE public.organizations SET deleted_at = now() WHERE id = 'e7b00000-0000-4000-8000-00000000000b';
SELECT pg_temp.as_user('e7555555-5555-4555-8555-555555555555');
SELECT throws_ok($$SELECT pg_temp.rep('e7b00000-0000-4000-8000-00000000000b','organization')$$, 'P3J02', NULL, 'deleted org has no report'); -- 44
RESET ROLE;
DELETE FROM public.chat_threads WHERE id = 'e7700000-0000-4000-8000-0000000000a3';
SELECT is((SELECT count(*)::int FROM public.provider_usage_events
  WHERE chat_turn_id = 'e7790000-0000-4000-8000-000000000001' AND chat_thread_id IS NULL), 3,
  'deleting a thread keeps its usage (thread reference nulled)'); -- 45
DELETE FROM public.organization_members WHERE organization_id = 'e7a00000-0000-4000-8000-00000000000a'
  AND user_id = 'e7444444-4444-4444-8444-444444444444';
SELECT pg_temp.as_user('e7111111-1111-4111-8111-111111111111');
SELECT ok((SELECT v->'by_user' @> '[{"user_id":"e7444444-4444-4444-8444-444444444444","is_member":false}]'::jsonb
  FROM (SELECT pg_temp.rep('e7a00000-0000-4000-8000-00000000000a','organization','day','2026-01-01T00:00:00Z','2026-01-03T00:00:00Z') v) s),
  'former members keep their history, flagged is_member=false'); -- 46
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
