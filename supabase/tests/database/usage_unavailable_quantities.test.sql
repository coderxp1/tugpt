-- usage_unavailable_quantities.test.sql — S0.4 / gate defect U6 (migration 20261125000003):
-- an 'unavailable' usage event carries NO token components (unknown is never stored as 0),
-- while a 'reported' event keeps its exact quantities; unavailable events have NULL cost.
BEGIN;
SELECT plan(6);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e8111111-1111-4111-8111-111111111111','authenticated','authenticated','u6_owner@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('e8a00000-0000-4000-8000-00000000000a','Usage U6','usage-u6');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('e8700000-0000-4000-8000-0000000000a3','e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111','U6','it-model');
INSERT INTO public.provider_prices (provider, model, dimension, unit_price, currency, effective_from, source) VALUES
 ('it-prov','it-model','input_tokens', 0.000002, 'USD', '2020-01-01', 'pgtap fixture price'),
 ('it-prov','it-model','output_tokens',0.000008, 'USD', '2020-01-01', 'pgtap fixture price');

CREATE FUNCTION pg_temp.rec(p_idx int, p_basis text, p_in bigint DEFAULT NULL, p_out bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_user; v jsonb;
BEGIN
  PERFORM set_config('role', 'sso_control', true);
  v := public.record_chat_usage('e8a00000-0000-4000-8000-00000000000a','e8111111-1111-4111-8111-111111111111',
    'e8700000-0000-4000-8000-0000000000a3','e8f00000-0000-4000-8000-0000000000f1', p_idx, 'chat', 'it-prov', 'it-model',
    p_in, p_out, p_basis, 'succeeded', 'req-u6');
  PERFORM set_config('role', v_prev, true);
  RETURN v;
END $f$;

SELECT is((pg_temp.rec(0, 'unavailable') ->> 'duplicate'), 'false', 'unavailable call recorded');
SELECT is((SELECT count(*)::int FROM public.provider_usage_components c
             JOIN public.provider_usage_events e ON e.id = c.event_id
            WHERE e.idempotency_key = 'chat:e8f00000-0000-4000-8000-0000000000f1:0'),
          0, 'U6: unavailable event has NO usage components at all (no zero quantities)');
SELECT is((SELECT cost_micros FROM public.provider_usage_events
            WHERE idempotency_key = 'chat:e8f00000-0000-4000-8000-0000000000f1:0'),
          NULL, 'unavailable event keeps NULL cost');
SELECT is((pg_temp.rec(1, 'reported', 120, 30) ->> 'duplicate'), 'false', 'reported call recorded');
SELECT is((SELECT json_object_agg(c.dimension, c.quantity) FROM public.provider_usage_components c
             JOIN public.provider_usage_events e ON e.id = c.event_id
            WHERE e.idempotency_key = 'chat:e8f00000-0000-4000-8000-0000000000f1:1'),
          '{"input_tokens": 120, "output_tokens": 30}'::json, 'reported event keeps exact provider quantities');
SELECT is((pg_temp.rec(1, 'reported', 120, 30) ->> 'duplicate'), 'true', 'same key stays a duplicate (no double count)');

SELECT * FROM finish();
ROLLBACK;
