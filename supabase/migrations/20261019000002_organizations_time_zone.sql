-- ===========================================================================
-- Phase 3, slice 2 follow-up: the trusted business time zone, stored.
--
-- Migration: 20261019000002_organizations_time_zone.sql
--
-- ===========================================================================
-- 1. WHAT THIS IS FOR, AND WHY IT IS A COLUMN, NOT A PARAMETER
-- ===========================================================================
--
-- Slice 1 took `timeZone` from the caller, and slice 2 records the trusted
-- zone on each appointment_request. The resolver
-- (`packages/appointments/src/time-zone-config.ts:resolveBusinessTimeZone`)
-- treats the organization's STORED zone as the only trusted source, but until
-- this migration there was nowhere trusted to store it: every caller supplied
-- it, which meant any caller could also supply the customer's.
--
-- This column is that source. It holds the zone the business operates in
-- (e.g. `Europe/Madrid`), and availability is computed in it. A
-- customer-supplied zone is a presentation concern: it may be used to render
-- a slot, and it must never be written here.
--
-- `organizations.locale` is deliberately NOT the source. Locale and zone are
-- different facts that happen to correlate; deriving one from the other gives
-- the right answer until a daylight-saving boundary, where the consequence is
-- a missed appointment.
--
-- NULL means "not configured". The resolver falls back to the platform
-- default, and fails loudly when neither exists. A NULL here is an explicit
-- unset state, not a guess and not a customer value.
--
-- ===========================================================================
-- 2. WHAT COUNTS AS A VALID ZONE
-- ===========================================================================
--
-- The zone must name an entry in `pg_timezone_names` — exact, case-sensitive,
-- unpadded. Offsets (`+02:00`), names the runtime rejects, and the
-- non-business entries are refused:
--
--   'localtime'   the database server's own local zone, not a business zone,
--                 and not something the JS runtime (ICU/Intl) accepts;
--   'posix/...', 'right/...'  alternate tzdata families the runtime rejects.
--
-- Validation is a STABLE helper function rather than a subquery because
-- CHECK constraints cannot contain subqueries. The database is a backstop:
-- the TypeScript resolver validates with Intl first, and a value that passes
-- here but not there is still refused at the boundary.
--
-- ===========================================================================
-- 3. ROLLBACK
-- ===========================================================================
--
-- Forward-only, like every migration here. To reverse manually:
--
--   ALTER TABLE public.organizations
--     DROP CONSTRAINT IF EXISTS organizations_time_zone_valid;
--   ALTER TABLE public.organizations DROP COLUMN IF EXISTS time_zone;
--   DROP FUNCTION IF EXISTS private.is_valid_iana_time_zone(TEXT);
--
-- Dropping the column loses the configured zone, not availability data. A
-- NULL on every row returns the system to the pre-migration behaviour: the
-- resolver falls back to the platform default or fails loudly.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 4. The validation helper
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.is_valid_iana_time_zone(p_zone TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
  SELECT p_zone IS NOT NULL
     AND p_zone <> 'localtime'
     AND p_zone NOT LIKE 'posix/%'
     AND p_zone NOT LIKE 'right/%'
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_zone
     );
$$;

-- The helper is invoked inside a CHECK constraint, so any role that inserts
-- or updates organizations must be able to execute it. Same pattern as the
-- other private helpers: revoke from anonymous roles, grant to the ones that
-- write.
REVOKE ALL ON FUNCTION private.is_valid_iana_time_zone(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_valid_iana_time_zone(TEXT)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The column and its constraint
-- ---------------------------------------------------------------------------

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS time_zone TEXT;

-- ADD CONSTRAINT has no IF NOT EXISTS; guard it the same way the enum
-- creations in earlier migrations are guarded.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'organizations_time_zone_valid'
      AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_time_zone_valid
      CHECK (time_zone IS NULL OR private.is_valid_iana_time_zone(time_zone));
  END IF;
END
$$;

COMMENT ON COLUMN public.organizations.time_zone IS
  'The business''s trusted IANA time zone (e.g. Europe/Madrid). Availability '
  'is computed in this zone. A customer-supplied zone is presentation-only '
  'and must never be stored here. NULL = not configured; resolution falls '
  'back to the platform default or fails loudly.';
