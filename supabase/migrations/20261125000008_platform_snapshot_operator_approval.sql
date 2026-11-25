-- B3 fix-up: platform snapshot approval has no user identity.
--
-- platform_tool_snapshots copied the customer registry's pair CHECK
-- ((approved_by IS NULL) = (approved_at IS NULL)), but platform approvals are
-- made by a platform operator through the token-gated Control Center, which
-- has no profiles row to attribute. Drop the pair CHECK on the PLATFORM
-- table only (the customer table keeps its own); approved_at alone records
-- the approval, and the immutability trigger keys off it as before.
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'public.platform_tool_snapshots'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%approved_by IS NULL%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.platform_tool_snapshots DROP CONSTRAINT %I', c);
  END IF;
END $$;
