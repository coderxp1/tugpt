-- ===========================================================================
-- FX seed refresh: EUR->USD ECB reference rate, 2026-10-21.
--
-- Migration: 20261022000002_fx_rate_seed_refresh.sql
--
-- WHY THIS EXISTS
--
-- The only EUR->USD row on main was the 2026-09-02 rate (1.1578)
-- seeded by 20260903000006. `private.fx_rate_status()` now reports
-- it stale, and fx_conversion.test.sql S1 — "the seeded rate is not
-- stale" — fails on every database-tests run against main (first
-- observed failing PR #7's head and PR #10's head, 2026-10-22; the
-- appointments branch is unaffected because it carries its own
-- 2026-10-19 seed). Staleness warns and never blocks conversions;
-- the failing assertion is the maintenance signal working as
-- designed. This is that maintenance.
--
-- THE RATE
--
-- ECB daily euro reference rate for reference date 2026-10-21:
-- EUR->USD 1.1234, read from the ECB's own daily reference feed
-- (eurofxref-daily.xml) on 2026-10-22. Reference date 2026-10-21
-- rather than the run day because the ECB publishes the current
-- day's rate late in the day — the same reason the original seed
-- carries 2026-09-02 read on 2026-09-03.
--
-- SHAPE
--
-- Same guarded insert as the original seed: one row, only if that
-- (pair, date) is absent. Rates are never updated in place — a
-- later rate is a new dated row, and `resolve_fx_rate` answers
-- as-of any instant from the rows in force then, so history is
-- not re-priced (fx_conversion R6 keeps asserting the 2026-09-02
-- rate for a 2026-09-02 instant).
--
-- TESTS ADJUSTED IN THE SAME CHANGE
--
-- fx_conversion R2 asserts the no-as-of resolution, which by
-- definition follows the newest row: 1.1578 -> 1.1234. No other
-- assertion moves: every dated fixture event predates 2026-10-21
-- and still resolves at the rate in force on its own date.
--
-- NOTE FOR THE APPOINTMENTS STACK: feat/appointments-availability-v1
-- carries seed migration 20261020000002 (1.1225 @ 2026-10-19) and
-- its own R2 expectation. When that branch merges, the migration
-- files do not conflict (different dates; the newer row governs),
-- but fx_conversion.test.sql will need its R2 expectation resolved
-- to this migration's rate, which is the newest.
-- ===========================================================================

INSERT INTO public.fx_rates (base_currency, quote_currency, rate, rate_date, source)
SELECT 'EUR', 'USD', 1.1234000000, '2026-10-21'::date,
       'ECB reference rate, 2026-10-21 (read from the ECB daily reference feed on 2026-10-22)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.fx_rates
  WHERE base_currency = 'EUR' AND quote_currency = 'USD'
    AND rate_date = '2026-10-21'::date
);
