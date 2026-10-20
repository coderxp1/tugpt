-- multi_currency.test.sql
--
-- Two currencies in the price book (migration 20260903000005): Langdock bills
-- EUR, Gladia bills USD.
--
-- 20260903000002 restricted every currency column to 'USD' and said the check
-- existed so that "the day a EUR-billing provider arrives, the constraint
-- fails loudly and someone makes a decision, instead of the totals quietly
-- becoming meaningless." This file is that decision, asserted.
--
-- THE CURRENCY IS DERIVED, NEVER DEFAULTED (C1-C6). `record_provider_usage`
-- did not set `currency` at all — it took the column default, which was 'USD'.
-- Harmless while USD was the only currency; the moment EUR rates exist it
-- stamps every Langdock event USD while its components carry EUR prices, which
-- passes every constraint and produces a total wrong by the exchange rate.
-- C1 is the assertion that would have caught it, and it is the reason this
-- migration is not simply eight INSERTs.
--
-- ONE EVENT, ONE CURRENCY (M1). An event's components are summed into its
-- total, so they must share a currency for that total to mean anything.
--
-- THE METER COUNTS BOTH CURRENCIES (T1-T5). Until 20260903000006 this block
-- asserted that any foreign-currency spend RAISED, because none of it could be
-- expressed in the accounting currency. FX conversion arrived on 2026-09-03
-- and the bar moved: convertible spend is converted and counted, and only
-- priced spend with no available rate still refuses. That refusal now lives in
-- `fx_conversion.test.sql`, which owns the conversion story; what stays here
-- is that two currencies in one period produce one honest total.
--
-- THE RATES ARE THE RATES (P1-P5). P2 asserts the per-1M figures a human
-- actually read off the vendor's page, recovered from what is stored, rather
-- than asserting the stored literal against itself.

BEGIN;
SELECT plan(20);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-c123-0000-0000-000000000001', 'owner@divisas.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-c123-0000-0000-000000000001', 'Casa de Divisas', 'divisas-currency-test'),
  ('aaaaaaaa-c123-0000-0000-000000000002', 'Solo Dolares', 'solo-dolares-currency-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-c123-0000-0000-000000000001', '11111111-c123-0000-0000-000000000001', 'owner');

-- ===========================================================================
-- C: the currency is derived from the prices used
-- ===========================================================================

-- A real Langdock draft: 1200 prompt tokens, 340 completion, on gpt-5-mini.
SELECT private.record_provider_usage(
  'aaaaaaaa-c123-0000-0000-000000000001', 'text', 'langdock', 'gpt-5-mini',
  '{"input_tokens": 1200, "output_tokens": 340}'::jsonb,
  'ld-call-1', 'req-eur-1');

-- THE ASSERTION THIS MIGRATION EXISTS FOR. Before it, this row said 'USD'.
SELECT is(
  (SELECT currency FROM public.provider_usage_events WHERE request_id = 'req-eur-1'),
  'EUR'::bpchar,
  'C1: a Langdock event is recorded in EUR, taken from the prices resolved '
  'for it rather than from a column default'
);

-- 1200 * 0.00000021 = 0.000252 EUR -> 252 µEUR
--  340 * 0.00000171 = 0.0005814 EUR -> round -> 581 µEUR
SELECT is(
  (SELECT cost_micros FROM public.provider_usage_events WHERE request_id = 'req-eur-1'),
  833::bigint,
  'C2: and costs 833 micro-euros — 252 in, 581 out'
);

SELECT private.record_provider_usage(
  'aaaaaaaa-c123-0000-0000-000000000001', 'audio', 'gladia', NULL,
  '{"audio_seconds": 60}'::jsonb, 'gl-call-1', 'req-usd-1');

-- The positive control for C1: without it, C1 would pass against an
-- implementation that hardcoded 'EUR' instead of 'USD'.
SELECT is(
  (SELECT currency FROM public.provider_usage_events WHERE request_id = 'req-usd-1'),
  'USD'::bpchar,
  'C3: a Gladia event in the same database is recorded in USD'
);

-- An unpriced call: no provider, so no price, so no currency either. The
-- currency of an unknown cost is also unknown.
SELECT private.record_provider_usage(
  'aaaaaaaa-c123-0000-0000-000000000001', 'text', 'nobody', 'nothing',
  '{"input_tokens": 500}'::jsonb, 'nb-call-1', 'req-unpriced-1');

SELECT ok(
  (SELECT cost_micros IS NULL AND currency IS NULL
     FROM public.provider_usage_events WHERE request_id = 'req-unpriced-1'),
  'C4: an unpriced event has neither a cost nor a currency'
);

SELECT throws_ok(
  $$INSERT INTO public.provider_usage_events
      (organization_id, modality, provider, model, cost_micros, currency)
    VALUES ('aaaaaaaa-c123-0000-0000-000000000001', 'text', 'x', 'y', 100, NULL)$$,
  '23514',
  NULL,
  'C5: a cost with no currency is refused — an unlabelled number'
);

SELECT throws_ok(
  $$INSERT INTO public.provider_usage_events
      (organization_id, modality, provider, model, cost_micros, currency)
    VALUES ('aaaaaaaa-c123-0000-0000-000000000001', 'text', 'x', 'y', NULL, 'USD')$$,
  '23514',
  NULL,
  'C6: a currency with no cost is refused — a label with nothing under it'
);

SELECT throws_ok(
  $$INSERT INTO public.provider_prices
      (provider, model, dimension, unit_price, currency, source, effective_from)
    VALUES ('gbpprov', 'm', 'input_tokens', 0.001, 'GBP',
            'fixture: an unsupported currency must be refused', '2020-01-01')$$,
  '23514',
  NULL,
  'C7: a currency outside the supported set is refused at the price, before '
  'any event can inherit it'
);

-- ===========================================================================
-- M: one event, one currency
-- ===========================================================================

-- A price book error: the same model priced in two currencies.
INSERT INTO public.provider_prices
  (provider, model, dimension, unit_price, currency, source, effective_from)
VALUES
  ('mixedprov', 'm1', 'input_tokens',  0.0000010000, 'EUR',
   'fixture: input priced in euros', '2020-01-01'),
  ('mixedprov', 'm1', 'output_tokens', 0.0000030000, 'USD',
   'fixture: output priced in dollars, which must be refused', '2020-01-01');

SELECT throws_ok(
  $$SELECT private.record_provider_usage(
      'aaaaaaaa-c123-0000-0000-000000000001', 'text', 'mixedprov', 'm1',
      '{"input_tokens": 100, "output_tokens": 100}'::jsonb,
      'mx-call-1', 'req-mixed-1')$$,
  'P3G04',
  NULL,
  'M1: components resolving prices in different currencies is refused, not '
  'added together'
);

-- The positive control for M1. One dimension alone is coherent, so it records.
SELECT lives_ok(
  $$SELECT private.record_provider_usage(
      'aaaaaaaa-c123-0000-0000-000000000001', 'text', 'mixedprov', 'm1',
      '{"input_tokens": 100}'::jsonb, 'mx-call-2', 'req-mixed-2')$$,
  'M2: and a single-currency event from the same provider still records, so '
  'M1 is about disagreement rather than about this provider'
);

-- ===========================================================================
-- T: the meter refuses rather than under-reports
-- ===========================================================================

INSERT INTO public.plans (id, key, name)
VALUES ('eeeeeeee-c123-0000-0000-000000000001', 'test_currency', 'Test Currency');

INSERT INTO public.organization_subscriptions
  (organization_id, plan_id, status, current_period_start, current_period_end)
VALUES
  ('aaaaaaaa-c123-0000-0000-000000000001',
   'eeeeeeee-c123-0000-0000-000000000001', 'active', CURRENT_DATE - 5, CURRENT_DATE + 25),
  ('aaaaaaaa-c123-0000-0000-000000000002',
   'eeeeeeee-c123-0000-0000-000000000001', 'active', CURRENT_DATE - 5, CURRENT_DATE + 25);

-- An organization whose spend is entirely in the accounting currency meters
-- normally. Without this, every assertion below would pass against a meter
-- that raised unconditionally.
SELECT private.record_provider_usage(
  'aaaaaaaa-c123-0000-0000-000000000002', 'audio', 'gladia', NULL,
  '{"audio_seconds": 60}'::jsonb, 'gl-call-2', 'req-usd-only');

SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-c123-0000-0000-000000000002', 'ai_cost_micros'),
  10167,
  'T1: an organization spending only in the accounting currency meters normally'
);

-- The organization from block C holds both EUR and USD spend in this period:
--   req-eur-1     833 µEUR  -> 935 µUSD at 1.1225
--   req-usd-1   10167 µUSD  -> 10167, no conversion
--   req-mixed-2   100 µEUR  -> 112 µUSD
--   req-unpriced-1 unpriced -> excluded, and does not raise
-- The euros are converted rather than dropped, and the dollars are not
-- converted twice.
SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-c123-0000-0000-000000000001', 'ai_cost_micros'),
  11214,
  'T2: a period holding both currencies meters as one total in the accounting '
  'currency — 935 + 10167 + 112'
);

-- The USD half alone would be 10283. Asserting that the answer is NOT that is
-- the difference between "it converted" and "it skipped the euros and nobody
-- noticed", which is the failure this whole design is arranged against.
SELECT isnt(
  private.current_entitlement_usage(
    'aaaaaaaa-c123-0000-0000-000000000001', 'ai_cost_micros'),
  10283,
  'T3: and is not merely the accounting-currency half — the euros are in there'
);

-- Window-scoped, not global: EUR spend outside the period being metered must
-- not trip the guard, or one euro of spend poisons an organization's meter
-- forever.
--
-- The period here is in the PAST and the spend is now, which looks backwards
-- until you try it the other way round: the Langdock rates became effective
-- today, so an event dated before today resolves no price at all, and an
-- unpriced event has a NULL cost that the guard skips for an entirely
-- different reason. The first version of this test did exactly that and passed
-- without exercising the window at all — it survived a mutation that deleted
-- the window conditions outright. Priced EUR spend outside a window therefore
-- means moving the window, not the spend.
INSERT INTO public.organizations (id, name, slug)
VALUES ('aaaaaaaa-c123-0000-0000-000000000003', 'Historico', 'historico-currency-test');

INSERT INTO public.organization_subscriptions
  (organization_id, plan_id, status, current_period_start, current_period_end)
VALUES ('aaaaaaaa-c123-0000-0000-000000000003',
        'eeeeeeee-c123-0000-0000-000000000001', 'active',
        CURRENT_DATE - 40, CURRENT_DATE - 10);

SELECT private.record_provider_usage(
  'aaaaaaaa-c123-0000-0000-000000000003', 'text', 'langdock', 'gpt-5-mini',
  '{"input_tokens": 1000}'::jsonb, 'ld-outside', 'req-eur-outside');

-- The event is real, priced, and in euros — the fixture only works if it is.
SELECT ok(
  (SELECT cost_micros IS NOT NULL AND currency = 'EUR'
     FROM public.provider_usage_events WHERE request_id = 'req-eur-outside'),
  'T4: the out-of-window fixture is priced EUR spend, not an unpriced row the '
  'guard would skip anyway'
);

SELECT is(
  private.current_entitlement_usage(
    'aaaaaaaa-c123-0000-0000-000000000003', 'ai_cost_micros'),
  0,
  'T5: and priced EUR spend outside the metered window neither trips the '
  'guard nor counts — the check is scoped to the period, not the organization'
);

-- ===========================================================================
-- P: the price book
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int FROM public.provider_prices
    WHERE provider = 'langdock' AND effective_to IS NULL),
  8,
  'P1: four models times two dimensions are priced'
);

SELECT is(
  (SELECT count(DISTINCT currency)::int FROM public.provider_prices
    WHERE provider = 'langdock'),
  1,
  'P2: all in one currency'
);

SELECT is(
  (SELECT currency FROM public.provider_prices
    WHERE provider = 'langdock' AND model = 'gpt-5-mini'
      AND dimension = 'input_tokens'),
  'EUR'::bpchar,
  'P3: and that currency is EUR, because Langdock is a German vendor billing '
  'in euros — the fact that was unconfirmed until 2026-09-03'
);

-- The figures a human read off the vendor's page, recovered from storage.
-- Asserting the stored literal back would only prove that copy-paste works.
--
-- ORDER BY ... COLLATE "C", and not by accident. Under C the sort is by byte,
-- so '-' (0x2D) precedes '.' (0x2E) and 'gpt-5-mini' comes before 'gpt-5.1'.
-- Under a linguistic collation — glibc en_US.UTF-8, which is what a real
-- Supabase database uses — punctuation is ignored at the primary level, the
-- keys compare as 'gpt51' against 'gpt5mini', and 'gpt-5.1' comes FIRST.
--
-- Written without the COLLATE this assertion passed on a C-collated local
-- database and failed in CI for three pull requests, with identical values in
-- a different order. The subject here is whether each rate survives storage,
-- not how model names sort, so the ordering is pinned to something that cannot
-- vary with the server's locale rather than being matched to one of them.
SELECT is(
  (SELECT string_agg(
     model || ':' || replace(dimension, '_tokens', '') || '=' ||
     to_char(round(unit_price * 1000000, 2), 'FM990.00'),
     ' ' ORDER BY model COLLATE "C", dimension COLLATE "C")
   FROM public.provider_prices WHERE provider = 'langdock'),
  'gpt-5:input=1.07 gpt-5:output=8.57 '
  'gpt-5-mini:input=0.21 gpt-5-mini:output=1.71 '
  'gpt-5.1:input=1.07 gpt-5.1:output=8.57 '
  'gpt-5.2:input=1.50 gpt-5.2:output=12.00',
  'P4: every rate recovers to the EUR-per-1M-tokens figure it was read from'
);

-- Pinned deliberately. gpt-5 and gpt-5.1 are identical per the source, and a
-- future reader noticing the duplication should find a test saying so rather
-- than "fixing" it.
SELECT is(
  (SELECT count(DISTINCT unit_price)::int FROM public.provider_prices
    WHERE provider = 'langdock' AND model IN ('gpt-5', 'gpt-5.1')),
  2,
  'P5: gpt-5 and gpt-5.1 price identically — two distinct values across the '
  'four rows, not four. Per the vendor, not a copy-paste slip'
);

-- ===========================================================================
-- I: the seed is idempotent
-- ===========================================================================

INSERT INTO public.provider_prices (
  provider, model, dimension, unit_price, currency, effective_from, source
)
SELECT 'langdock', v.model, v.dimension, v.unit_price, 'EUR',
       '2026-09-03T00:00:00Z'::timestamptz, 'rerun of the migration seed'
FROM (VALUES ('gpt-5-mini', 'input_tokens', 0.0000002100::numeric))
  AS v(model, dimension, unit_price)
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_prices p
  WHERE p.provider = 'langdock' AND p.model = v.model
    AND p.dimension = v.dimension AND p.effective_to IS NULL
);

SELECT is(
  (SELECT count(*)::int FROM public.provider_prices
    WHERE provider = 'langdock' AND model = 'gpt-5-mini'
      AND dimension = 'input_tokens'),
  1,
  'I1: re-running the seed adds nothing'
);

SELECT * FROM finish();
ROLLBACK;
