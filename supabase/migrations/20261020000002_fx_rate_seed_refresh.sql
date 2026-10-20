-- ===========================================================================
-- FX seed refresh: EUR->USD reference rate, 2026-10-20
-- ===========================================================================
--
-- WHY THIS EXISTS
--
-- The original seed (20260903000006) entered the ECB reference rate for
-- 2026-09-02. Staleness is judged against private.fx_rate_max_age_days()
-- = 45 days, so that row crossed the threshold on 2026-10-17 and the
-- fx_conversion pgTAP assertion "S1: the seeded rate is not stale" has
-- been red in every environment since — a calendar defect in the seed
-- data, not in the conversion code.
--
-- fx_rates is an append-only table of dated snapshots by design, and
-- private.resolve_fx_rate() resolves the newest rate_date at or before
-- the instant being converted, so refreshing the seed means appending
-- the current rate as a new row. The 2026-09-02 row is history and is
-- deliberately left untouched; editing an applied migration to change
-- it would diverge fresh databases from ones that already ran it.
--
-- The original migration's header prescribes exactly this maintenance:
-- rates are "updated manually, monthly cadence acceptable". Expect this
-- refresh to be needed again roughly every 45 days for as long as the
-- EUR->USD pair is seeded rather than fed.
--
-- SOURCE
--
-- ECB daily euro reference rate, read from the ECB's own feed
-- (eurofxref-daily.xml) on 2026-10-20: 1.1215 for reference date
-- 2026-10-20. Same source and method as the original seed.
--
-- Idempotent in the same shape as the original seed: re-running this
-- migration does not duplicate the row.
-- ===========================================================================

INSERT INTO public.fx_rates (base_currency, quote_currency, rate, rate_date, source)
SELECT 'EUR', 'USD', 1.1215000000, '2026-10-20'::date,
       'ECB reference rate, 2026-10-20 (read from the ECB daily reference feed on 2026-10-20)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.fx_rates
  WHERE base_currency = 'EUR' AND quote_currency = 'USD'
    AND rate_date = '2026-10-20'::date
);
