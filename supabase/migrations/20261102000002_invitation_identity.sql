-- Review candidate: production approval required.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Fail during migration, not during the first invitation, if Auth schema/access differs.
DO $preflight$ BEGIN
 PERFORM u.id,u.email,u.email_confirmed_at,u.deleted_at FROM auth.users u LIMIT 0;
END; $preflight$;
CREATE OR REPLACE FUNCTION private.accept_invitation(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_email TEXT;
  v_inv RECORD;
  v_existing public.organization_role;
  v_created BOOLEAN := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = 'P3D01';
  END IF;

  SELECT lower(btrim(email)) INTO v_email FROM auth.users
  WHERE id = v_user AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Verified email required' USING ERRCODE = 'P3D10';
  END IF;

  SELECT * INTO v_inv
  FROM public.organization_invitations
  WHERE token_hash = private.hash_invitation_token(p_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation' USING ERRCODE = 'P3D01';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=v_inv.organization_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Invalid invitation' USING ERRCODE='P3D01';
  END IF;

  -- Identity is checked before status, so that someone holding a token issued
  -- to another address learns nothing about whether it is still live.
  IF lower(v_inv.email) <> v_email THEN
    RAISE EXCEPTION 'Invitation was issued to a different address'
      USING ERRCODE = 'P3D06';
  END IF;

  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is no longer pending' USING ERRCODE = 'P3D04';
  END IF;

  IF v_inv.expires_at < now() THEN
    -- The original wrote `status = 'expired'` here and then raised. The raise
    -- aborts the function, which rolls back its own UPDATE, so the row was
    -- never actually marked — the statement looked like bookkeeping and did
    -- nothing. plpgsql has no autonomous transaction to fix that with, so the
    -- sweep lives in `create_invitation` instead, where it runs on a path that
    -- commits.
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = 'P3D05';
  END IF;

  SELECT role INTO v_existing
  FROM public.organization_members
  WHERE organization_id = v_inv.organization_id AND user_id = v_user;

  IF NOT FOUND THEN
    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES (v_inv.organization_id, v_user, v_inv.role);
    v_created := true;
  END IF;
  -- else: membership already exists and is left exactly as it is. See the
  -- header. An invitation is not a role-change instrument.

  -- Marked accepted in both branches. An invitation that stays pending after
  -- being presented is a token that can be replayed, and the replay is the
  -- interesting case precisely when the user is already a member.
  UPDATE public.organization_invitations
  SET status = 'accepted', updated_at = now()
  WHERE id = v_inv.id;

  INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
  VALUES (v_inv.organization_id, v_user, 'invitation.accept', 'invitation',
          jsonb_build_object(
            'invitation_id', v_inv.id,
            'role', v_inv.role,
            'membership_created', v_created,
            'existing_role', v_existing));

  RETURN jsonb_build_object(
    'organization_id', v_inv.organization_id,
    'membership_created', v_created,
    -- The role they actually hold now, which is NOT necessarily the invited
    -- role. Saying otherwise would put a wrong permission set on the screen.
    'role', COALESCE(v_existing, v_inv.role)
  );
END;
$$;
REVOKE UPDATE ON public.profiles FROM PUBLIC,anon,authenticated;
GRANT UPDATE(full_name,avatar_url,preferred_locale) ON public.profiles TO authenticated;
COMMIT;
