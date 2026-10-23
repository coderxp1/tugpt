-- organizations_time_zone.test.sql
--
-- The trusted business time zone — migration 20261019000002.
--
-- Two claims carry this file.
--
-- THE STORED ZONE IS A REAL IANA ZONE, OR NOTHING (Z1-Z9). The column is the
-- value availability arithmetic trusts. A made-up zone, an offset, a padded
-- or mis-cased name must be refused at the database, not discovered later in
-- a customer's booking. NULL — nothing configured — is the one non-zone
-- value allowed, and it means the resolver must fall back or fail loudly.
--
-- CONVERSIONS BEHAVE AS DOCUMENTED AT DST BOUNDARIES (D1-D6). A spring gap
-- (02:30 that does not exist) and an autumn overlap (02:30 that happens
-- twice) must resolve the way PostgreSQL resolves them, asserted exactly so
-- a tzdata change that moves a boundary fails here instead of in production.

BEGIN;
SELECT plan(15);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug) VALUES
  ('bbbbbbbb-4e70-0000-0000-000000000010', 'TZ Fixture', 'tz-fixture-org');

-- ===========================================================================
-- Z: the column and its validation
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'organizations'
     AND column_name = 'time_zone'),
  1,
  'Z1: organizations has a time_zone column'
);

SELECT lives_ok(
  $$UPDATE public.organizations
    SET time_zone = 'Europe/Madrid'
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  'Z2: a valid IANA zone is accepted'
);

SELECT is(
  (SELECT time_zone FROM public.organizations
   WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'),
  'Europe/Madrid',
  'Z3: the stored zone reads back exactly'
);

SELECT throws_ok(
  $$UPDATE public.organizations
    SET time_zone = 'Mars/Olympus'
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  '23514',
  NULL,
  'Z4: a made-up zone is refused'
);

-- An offset is not a zone: it does not carry the rules (DST, historical
-- changes) that availability depends on.
SELECT throws_ok(
  $$UPDATE public.organizations
    SET time_zone = '+02:00'
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  '23514',
  NULL,
  'Z5: a UTC offset is not accepted as a zone'
);

SELECT throws_ok(
  $$UPDATE public.organizations
    SET time_zone = ' Europe/Madrid '
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  '23514',
  NULL,
  'Z6: a whitespace-padded zone name is refused'
);

SELECT throws_ok(
  $$UPDATE public.organizations
    SET time_zone = 'europe/madrid'
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  '23514',
  NULL,
  'Z7: zone names are case-sensitive and must match IANA spelling'
);

-- 'localtime' names a real row in pg_timezone_names, but it is the database
-- server''s zone, not a business''s — and the JS runtime rejects it.
SELECT throws_ok(
  $$UPDATE public.organizations
    SET time_zone = 'localtime'
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  '23514',
  NULL,
  'Z8: ''localtime'' is refused: it is not a business zone'
);

SELECT lives_ok(
  $$UPDATE public.organizations
    SET time_zone = NULL
    WHERE id = 'bbbbbbbb-4e70-0000-0000-000000000010'$$,
  'Z9: NULL is allowed: it means "not configured", not a zone'
);

-- ===========================================================================
-- D: conversion semantics at daylight-saving boundaries
-- ===========================================================================

-- Europe/Madrid springs forward on 2026-03-29: 02:00 CET becomes 03:00 CEST,
-- so 02:30 does not exist. PostgreSQL resolves it past the gap: the instant
-- is 03:30 CEST, 01:30 UTC. Availability computed here must use the instant
-- the runtime''s Intl arithmetic also produces.
SELECT is(
  timezone('Europe/Madrid', TIMESTAMP '2026-03-29 02:30:00'),
  TIMESTAMPTZ '2026-03-29 01:30:00+00',
  'D1: a nonexistent local time (spring gap) resolves forward past the gap'
);

-- Europe/Madrid falls back on 2026-10-25: 03:00 CEST becomes 02:00 CET, so
-- 02:30 happens twice. PostgreSQL resolves the ambiguous reading to the
-- post-transition offset: 02:30 CET, 01:30 UTC.
SELECT is(
  timezone('Europe/Madrid', TIMESTAMP '2026-10-25 02:30:00'),
  TIMESTAMPTZ '2026-10-25 01:30:00+00',
  'D2: an ambiguous local time (autumn overlap) resolves to the post-transition offset'
);

-- An unknown zone in a conversion is an error, not a silent UTC default.
SELECT throws_ok(
  $$SELECT timezone('Mars/Olympus', now())$$,
  '22023',
  NULL,
  'D3: converting in an unknown zone is an error (22023)'
);

-- The same instant, rendered in the business''s zone, is the business''s
-- local time. Madrid is UTC+1 in January.
SELECT is(
  TIMESTAMPTZ '2026-01-15T09:00:00Z' AT TIME ZONE 'Europe/Madrid',
  TIMESTAMP '2026-01-15 10:00:00',
  'D4: a UTC instant converts to business-local time (Madrid, winter)'
);

-- A different business, same instant, different local reading — the zone is
-- the authority, not the instant and not the customer. Mexico City is UTC-6
-- in January.
SELECT is(
  TIMESTAMPTZ '2026-01-15T15:00:00Z' AT TIME ZONE 'America/Mexico_City',
  TIMESTAMP '2026-01-15 09:00:00',
  'D5: the same UTC instant has a different local reading in another business zone'
);

-- The validator itself: NULL is not a zone. The column accepts NULL through
-- the CHECK''s explicit OR; the function must not be what lets it through.
SELECT is(
  private.is_valid_iana_time_zone(NULL),
  false,
  'D6: the validation helper refuses NULL (unset is a column-level decision)'
);

SELECT * FROM finish();
ROLLBACK;
