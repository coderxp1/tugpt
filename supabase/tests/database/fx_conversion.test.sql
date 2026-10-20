-- fx_conversion.test.sql
--
-- EUR->USD accounting (migration 20260903000006). Paul's decision, 2026-09-03:
-- ECB daily euro reference rate, entered manually, monthly cadence acceptable,
-- and a stale rate WARNS but does not BLOCK.
--
-- THE RATE IN FORCE IS THE LATEST ONE AT OR BEFORE THE INSTANT (R1-R6). Not
-- "the newest row" -- R3 requires that a rate published after an event is not
-- reached backwards for, because valuing last quarter at today's rate is
-- inventing history, and R4's positive control requires that the newest
-- eligible rate does win.
--
-- IDENTITY NEEDS NO ROW (R1, R6). A database with an empty fx_rates table must
-- still account USD spend in USD. Returning NULL there would make the meter
-- refuse every organization on the day this shipped.
--
-- THE CONVERSION IS STORED, NOT RECOMPUTED (C1, C6). The rate and its date go
-- on the row. C6 moves the rate afterwards and requires the recorded figure
-- not to follow -- without which last month's total silently changes every
-- time somebody enters a new rate.
--
-- AN EVENT ALREADY IN THE ACCOUNTING CURRENCY STORES NO RATE (C2). A stored
-- 1.0 would record a conversion that never happened. The CHECKs encode that
-- asymmetry deliberately: a rate implies a converted amount, but not the
-- reverse.
--
-- STALE WARNS, NEVER BLOCKS (S1-S4). S3 is the one that matters: a rate well
-- past the threshold must still convert and the meter must still answer.

BEGIN;
SELECT plan(28);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-fbfb-0000-0000-000000000001', 'owner@cambio.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-fbfb-0000-0000-000000000001', 'Casa de Cambio', 'cambio-fx-test'),
  ('aaaaaaaa-fbfb-0000-0000-000000000002', 'Sin Tasa', 'sin-tasa-fx-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-fbfb-0000-0000-000000000001', '11111111-fbfb-0000-0000-000000000001', 'owner');

INSERT INTO public.plans (id, key, name)
VALUES ('eeeeeeee-fbfb-0000-0000-000000000001', 'test_fx', 'Test FX');

INSERT INTO public.organization_subscriptions
  (organization_id, plan_id, status, current_period_start, current_period_end)
VALUES
  ('aaaaaaaa-fbfb-0000-0000-000000000001',
   'eeeeeeee-fbfb-0000-0000-000000000001', 'active', CURRENT_DATE - 5, CURRENT_DATE + 25),
  -- Fixed dates, not CURRENT_DATE-relative: this organization's period has to
  -- sit entirely BEFORE the ECB rate's date (2026-09-02) for its spend to be
  -- priced-but-unconvertible, and a relative window would stop being that the
  -- moment the suite runs on a later day.
  ('aaaaaaaa-fbfb-0000-0000-000000000002',
   'eeeeeeee-fbfb-0000-0000-000000000001', 'active',
   '2026-08-25'::date, '2026-09-01'::date);

-- ===========================================================================
-- R: rate resolution
-- ===========================================================================

SELECT is(
  (SELECT rate FROM private.resolve_fx_rate('USD', 'USD')),
  1::numeric,
  'R1: a currency converts to itself at 1, without consulting the table'
);

SELECT is(
  (SELECT rate FROM private.resolve_fx_rate('EUR', 'USD')),
  1.1225000000::numeric,
  'R2: the seeded ECB rate resolves'
);

SELECT is(
  (SELECT rate_date FROM private.resolve_fx_rate('EUR', 'USD')),
  '2026-10-19'::date,
  'R3: and carries the date it was published for, which is not today — '
  'the seed is always the most recent completed ECB day (20261020000002)'
);

SELECT is(
  (SELECT rate FROM private.resolve_fx_rate('EUR', 'USD', '2026-08-01'::timestamptz)),
  NULL::numeric,
  'R4: a rate published later is not reached backwards for — valuing old '
  'spend at a newer rate would be inventing history'
);

-- A second, later rate. The positive control for R4: without it, R4 would
-- pass against a resolver that never returned anything.
INSERT INTO public.fx_rates (base_currency, quote_currency, rate, rate_date, source)
VALUES ('EUR', 'USD', 1.2000000000, CURRENT_DATE,
        'fixture: a later rate that must win for an instant after it');

SELECT is(
  (SELECT rate FROM private.resolve_fx_rate('EUR', 'USD')),
  1.2000000000::numeric,
  'R5: the most recent rate at or before the instant wins'
);

SELECT is(
  (SELECT rate FROM private.resolve_fx_rate('EUR', 'USD', '2026-09-02T12:00:00Z'::timestamptz)),
  1.1578000000::numeric,
  'R6: and asking as-of an earlier instant still returns the rate in force '
  'then, so history is answerable'
);

-- Two different rates for one pair on one day would make resolution pick by
-- row order, so an event's accounted cost would depend on insert sequence —
-- the same failure `provider_usage_and_cost.test.sql` R5 guards against for
-- prices. There is no tiebreak in the resolver and there should not need to be.
SELECT throws_ok(
  $$INSERT INTO public.fx_rates
      (base_currency, quote_currency, rate, rate_date, source)
    VALUES ('EUR', 'USD', 1.3000000000, CURRENT_DATE,
            'fixture: a second rate for a day that already has one')$$,
  '23505',
  NULL,
  'R7: a second rate for the same pair and date is refused'
);

-- Remove the fixture rate so the remaining blocks work against the real one.
DELETE FROM public.fx_rates WHERE rate = 1.2000000000;

-- ===========================================================================
-- C: the conversion is recorded on the event
-- ===========================================================================

-- 1200 in + 340 out on gpt-5-mini = 833 µEUR (252 + 581).
SELECT private.record_provider_usage(
  'aaaaaaaa-fbfb-0000-0000-000000000001', 'text', 'langdock', 'gpt-5-mini',
  '{"input_tokens": 1200, "output_tokens": 340}'::jsonb, 'ld-fx-1', 'req-fx-eur');

-- 833 * 1.1225 = 934.9425 -> 935
SELECT is(
  (SELECT accounting_cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-fx-eur'),
  935::bigint,
  'C1: 833 micro-euros is accounted as 935 micro-dollars at 1.1225'
);

SELECT ok(
  (SELECT fx_rate = 1.1225000000 AND fx_rate_date = '2026-10-19'::date
          AND accounting_currency = 'USD' AND currency = 'EUR'
     FROM public.provider_usage_events WHERE request_id = 'req-fx-eur'),
  'C2: and the row carries the rate, its date, and both currencies — so the '
  'figure can be re-derived from the row alone'
);

SELECT private.record_provider_usage(
  'aaaaaaaa-fbfb-0000-0000-000000000001', 'audio', 'gladia', NULL,
  '{"audio_seconds": 60}'::jsonb, 'gl-fx-1', 'req-fx-usd');

SELECT ok(
  (SELECT accounting_cost_micros = cost_micros
          AND accounting_currency = 'USD'
          AND fx_rate IS NULL AND fx_rate_date IS NULL
     FROM public.provider_usage_events WHERE request_id = 'req-fx-usd'),
  'C3: an event already in the accounting currency is accounted at its own '
  'value and stores NO rate — a stored 1.0 would record a conversion that '
  'never happened'
);

-- Priced, but in a currency with no rate at its date.
--
-- This needs a fixture provider rather than Langdock. The Langdock rates take
-- effect 2026-09-03 and the ECB rate is dated 2026-09-02, so every instant at
-- which a Langdock call is PRICED also has a rate — an event dated earlier
-- comes back unpriced, which is a different condition that this guard
-- deliberately ignores. The first version of this test made exactly that
-- mistake and asserted nothing; so did the window test in
-- multi_currency.test.sql before it. A EUR price reaching back to 2020 is
-- what makes "priced but unconvertible" reachable at all.
INSERT INTO public.provider_prices
  (provider, model, dimension, unit_price, currency, source, effective_from)
VALUES ('eurprov', 'm1', 'input_tokens', 0.0000010000, 'EUR',
        'fixture: a EUR rate in force long before any FX rate exists',
        '2020-01-01');

SELECT private.record_provider_usage(
  'aaaaaaaa-fbfb-0000-0000-000000000002', 'text', 'eurprov', 'm1',
  '{"input_tokens": 1000}'::jsonb, 'ep-fx-old', 'req-fx-norate',
  NULL, NULL, '{}'::jsonb, '2026-08-31T00:00:00Z'::timestamptz);

-- The fixture is the thing under test only if it really is priced EUR spend.
SELECT ok(
  (SELECT cost_micros = 1000 AND currency = 'EUR'
     FROM public.provider_usage_events WHERE request_id = 'req-fx-norate'),
  'C4: the unconvertible fixture is genuinely priced EUR spend, not an '
  'unpriced row that would be skipped for an unrelated reason'
);

SELECT ok(
  (SELECT accounting_cost_micros IS NULL AND accounting_currency IS NULL
          AND fx_rate IS NULL
     FROM public.provider_usage_events WHERE request_id = 'req-fx-norate'),
  'C4b: and it keeps its native cost with no accounting expression — '
  'recorded, not dropped, and not guessed at'
);

SELECT throws_ok(
  $$UPDATE public.provider_usage_events
      SET fx_rate = 1.1, fx_rate_date = '2026-09-02'
    WHERE request_id = 'req-fx-norate'$$,
  '23514',
  NULL,
  'C5: a rate cannot be recorded without a converted amount to go with it'
);

SELECT throws_ok(
  $$UPDATE public.provider_usage_events SET accounting_cost_micros = 5
    WHERE request_id = 'req-fx-norate'$$,
  '23514',
  NULL,
  'C6: nor a converted amount without the currency it is in'
);

-- History does not move when the rate does. Without this, last month's total
-- silently changes every time somebody enters a new rate.
INSERT INTO public.fx_rates (base_currency, quote_currency, rate, rate_date, source)
VALUES ('EUR', 'USD', 1.9900000000, CURRENT_DATE,
        'fixture: a wildly different later rate, to prove history is frozen');

SELECT is(
  (SELECT accounting_cost_micros FROM public.provider_usage_events
    WHERE request_id = 'req-fx-eur'),
  935::bigint,
  'C7: a later rate does not re-price an event already recorded'
);

DELETE FROM public.fx_rates WHERE rate = 1.9900000000;

-- ===========================================================================
-- M: the meter
-- ===========================================================================

-- 935 (converted EUR) + 10167 (native USD). Before 20260903000006 this
-- organization raised P3G05, because none of its EUR spend could be expressed
-- in the accounting currency.
SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-fbfb-0000-0000-000000000001', 'ai_cost_micros'),
  11102,
  'M1: a period mixing EUR and USD spend sums in the accounting currency'
);

-- The refusal did not go away, its bar moved: from "any foreign currency" to
-- "priced spend that genuinely cannot be expressed".
SELECT throws_ok(
  $$SELECT private.current_entitlement_usage(
      'aaaaaaaa-fbfb-0000-0000-000000000002', 'ai_cost_micros')$$,
  'P3G05',
  NULL,
  'M2: priced spend with no available rate still raises rather than being '
  'silently skipped'
);

SELECT throws_like(
  $$SELECT private.current_entitlement_usage(
      'aaaaaaaa-fbfb-0000-0000-000000000002', 'ai_cost_micros')$$,
  '%no FX rate for its currency on or before its date%',
  'M3: and says which input is missing rather than what went wrong'
);

-- Unpriced spend is a different thing from unconvertible spend and must not
-- trip the same guard: there is nothing to convert, so nothing is being
-- skipped.
SELECT private.record_provider_usage(
  'aaaaaaaa-fbfb-0000-0000-000000000001', 'text', 'nobody', 'nothing',
  '{"input_tokens": 500}'::jsonb, 'nb-fx-1', 'req-fx-unpriced');

SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-fbfb-0000-0000-000000000001', 'ai_cost_micros'),
  11102,
  'M4: an unpriced event neither counts nor raises — it has no cost to skip'
);

-- ===========================================================================
-- S: staleness warns, never blocks
-- ===========================================================================

SELECT ok(
  (SELECT NOT is_stale FROM private.fx_rate_status()
    WHERE base_currency = 'EUR' AND quote_currency = 'USD'),
  'S1: the seeded rate is not stale'
);

-- A pair whose newest rate is old. USD->EUR is unused by the accounting
-- direction, so this exercises staleness without disturbing EUR->USD.
INSERT INTO public.fx_rates (base_currency, quote_currency, rate, rate_date, source)
VALUES ('USD', 'EUR', 0.8600000000, CURRENT_DATE - 200,
        'fixture: a rate far past the staleness threshold');

SELECT ok(
  (SELECT is_stale FROM private.fx_rate_status()
    WHERE base_currency = 'USD' AND quote_currency = 'EUR'),
  'S2: a rate 200 days old reports stale — the positive control for S1'
);

SELECT is(
  (SELECT age_days FROM private.fx_rate_status()
    WHERE base_currency = 'USD' AND quote_currency = 'EUR'),
  200,
  'S3: and its age is reported, so an operator can alert on it rather than '
  'discover it'
);

-- THE ASSERTION THE DECISION TURNS ON. An event far enough after the rate to
-- be stale must still convert, and the meter must still answer. Blocking here
-- would mean a missing monthly rate update stops enforcement entirely, which
-- is worse than enforcing a couple of percent wrong.
SELECT private.record_provider_usage(
  'aaaaaaaa-fbfb-0000-0000-000000000001', 'text', 'langdock', 'gpt-5-mini',
  '{"input_tokens": 1200, "output_tokens": 340}'::jsonb, 'ld-fx-stale', 'req-fx-stale',
  NULL, NULL, '{}'::jsonb, pg_catalog.now() + interval '200 days');

SELECT ok(
  (SELECT accounting_cost_micros = 935 AND fx_rate = 1.1225000000
     FROM public.provider_usage_events WHERE request_id = 'req-fx-stale'),
  'S4: spend 200 days past the rate still converts, at the stale rate, rather '
  'than being refused'
);

-- ===========================================================================
-- W: the deploy gate can read it
-- ===========================================================================

-- 20260903000007. Without a reader, "warn but do not block" is just "do not
-- block", so the preflight gate calls this on every deploy.
SELECT is(
  (SELECT count(*)::int FROM public.fx_rate_status()),
  (SELECT count(*)::int FROM private.fx_rate_status()),
  'W1: the public wrapper returns what the private function returns'
);

SELECT ok(
  (SELECT is_stale FROM public.fx_rate_status()
    WHERE base_currency = 'USD' AND quote_currency = 'EUR'),
  'W2: including the staleness flag the gate keys off — one threshold, not a '
  'copy of 45 maintained in TypeScript as well'
);

-- Operational surface is not granted to customers by default. Nothing here is
-- customer data; the rule is that an exception should be argued for.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.fx_rate_status()', 'EXECUTE'),
  'W3: authenticated cannot execute it'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.fx_rate_status()', 'EXECUTE'),
  'W4: nor anon'
);

SELECT ok(
  has_function_privilege('service_role', 'public.fx_rate_status()', 'EXECUTE'),
  'W5: service_role can — the positive control, without which W3 and W4 would '
  'pass against a function nobody can call at all'
);

SELECT * FROM finish();
ROLLBACK;
