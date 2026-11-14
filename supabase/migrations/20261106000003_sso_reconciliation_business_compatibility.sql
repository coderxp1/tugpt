-- P2 source preparation only. NOT EXECUTED. Not a production operation plan.
-- Only an explicitly approved disposable bootstrap may use the postgres owner.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Reviewed disposable owner required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres' AND rolsuper) THEN
  RAISE EXCEPTION 'Reviewed bootstrap owner properties required'; END IF;
END $$;
-- Only existing business implementations are replaced. ACLs survive replacement.
-- Preflight effective baseline ACLs before using this chain; no shared grant repair.
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

  IF auth.jwt()->>'iss'='urn:tugpt:dashboard:bridge' THEN
    PERFORM sso.require_session();
    SELECT lower(btrim(canonical_email)) INTO v_email FROM sso.sessions
    WHERE hash=auth.jwt()->>'dash_session' AND subject=v_user
      AND email_verified_at>clock_timestamp()-interval '60 seconds';
  ELSE
    SELECT lower(btrim(email)) INTO v_email FROM auth.users
    WHERE id=v_user AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL;
  END IF;
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

  IF v_inv.expires_at <= clock_timestamp() THEN
    -- The original wrote `status = 'expired'` here and then raised. The raise
    -- aborts the function, which rolls back its own UPDATE, so the row was
    -- never actually marked — the statement looked like bookkeeping and did
    -- nothing. plpgsql has no autonomous transaction to fix that with, so the
    -- sweep lives in `create_invitation` instead, where it runs on a path that
    -- commits.
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = 'P3D05';
  END IF;

  PERFORM private.lock_organization_membership(v_inv.organization_id);
  -- Lock waits must not extend invitation, session or verified-email validity.
  IF v_inv.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE='P3D05';
  END IF;
  IF auth.jwt()->>'iss'='urn:tugpt:dashboard:bridge' THEN
    PERFORM sso.require_session();
    IF NOT EXISTS(SELECT 1 FROM sso.sessions WHERE hash=auth.jwt()->>'dash_session'
      AND canonical_email IS NOT NULL AND email_verified_at>clock_timestamp()-interval '60 seconds') THEN
      RAISE EXCEPTION 'Verified email required' USING ERRCODE='P3D10';
    END IF;
  END IF;
  IF coalesce(private.get_user_org_role(v_inv.organization_id,v_inv.invited_by)::text,'') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Invitation issuer no longer authorized' USING ERRCODE='P3D04';
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
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(p_name text,p_slug text,p_owner_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
 IF actor IS NULL OR actor IS DISTINCT FROM p_owner_id THEN RAISE EXCEPTION 'Owner must be caller' USING ERRCODE='42501'; END IF;
 IF auth.jwt()->>'iss'='urn:tugpt:dashboard:bridge' THEN actor:=sso.require_session(); END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 OR p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' THEN RAISE EXCEPTION 'Invalid organization' USING ERRCODE='22023'; END IF;
 RETURN private.create_organization_with_owner(p_name,p_slug,actor);
END $$;

-- Retain pre-existing service-specific rights; do not invent service/control access.
REVOKE ALL ON FUNCTION private.accept_invitation(text) FROM PUBLIC,anon,authenticated,sso_control;
REVOKE ALL ON FUNCTION public.accept_invitation(text) FROM PUBLIC,anon,sso_control;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_organization_with_owner(text,text,uuid) FROM PUBLIC,anon,sso_control;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(text,text,uuid) TO authenticated;
-- Private create_organization_with_owner and its baseline grants remain untouched.
-- CREATE rights/search-path/effective inherited ACL and overload audits remain mandatory.
-- BEGIN P2-DB-01: two new bridge-only read wrappers. Source only; NOT EXECUTED.
-- Existing service-only delivery RPC bodies/owners/grants remain untouched.
-- Guards acquire family/session/membership locks; they may update membership
-- lock bookkeeping. No delivery/queue/provider business writes occur here.
CREATE FUNCTION public.sso_get_outbound_delivery_for_draft(
 p_organization_id uuid,p_draft_id uuid)
RETURNS TABLE(id uuid, organization_id uuid, draft_id uuid, status text,
 provider_message_id text, attempts integer, error_code text,
 updated_at timestamptz, delivered_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM sso.require_actor(p_organization_id,false);
 IF public.is_feature_enabled(p_organization_id,'ai_draft_generation') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Feature unavailable' USING ERRCODE='42501';
 END IF;
 IF p_draft_id IS NULL THEN
  RAISE EXCEPTION 'Invalid draft identifier' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 SELECT o.id,o.organization_id,o.draft_id,o.status,o.provider_message_id,
        o.attempts,o.error_code,o.updated_at,o.delivered_at,o.read_at
 FROM public.outbound_message_deliveries AS o
 JOIN public.ai_drafts AS d ON d.id=o.draft_id AND d.organization_id=o.organization_id
 WHERE d.organization_id=p_organization_id AND o.organization_id=p_organization_id
 AND o.draft_id=p_draft_id;
 -- RETURN QUERY buffers in PL/pgSQL; a later exception discards all rows.
 -- Recheck after query/lock waits, including elapsed assertion/session deadlines.
 PERFORM sso.require_actor(p_organization_id,false);
 IF public.is_feature_enabled(p_organization_id,'ai_draft_generation') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Feature unavailable' USING ERRCODE='42501';
 END IF;
 -- The feature lookup may itself wait; validate temporal/session state last.
 PERFORM sso.require_session();
END $$;
CREATE FUNCTION public.sso_list_outbound_deliveries_for_drafts(
 p_organization_id uuid,p_draft_ids uuid[])
RETURNS TABLE(id uuid, organization_id uuid, draft_id uuid, status text,
 provider_message_id text, attempts integer, error_code text,
 updated_at timestamptz, delivered_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM sso.require_actor(p_organization_id,false);
 IF public.is_feature_enabled(p_organization_id,'ai_draft_generation') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Feature unavailable' USING ERRCODE='42501';
 END IF;
 -- Empty arrays are valid (zero rows), but authorization/gating still applies.
 -- Count supplied entries, not distinct entries, and reject multidimensional,
 -- non-one-based, null arrays and null elements before the delivery query.
 IF p_draft_ids IS NULL OR cardinality(p_draft_ids)>100 OR
    (cardinality(p_draft_ids)>0 AND
     (array_ndims(p_draft_ids)<>1 OR array_lower(p_draft_ids,1)<>1)) THEN
  RAISE EXCEPTION 'Invalid draft identifiers' USING ERRCODE='22023';
 END IF;
 IF array_position(p_draft_ids,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'Invalid draft identifiers' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 SELECT o.id,o.organization_id,o.draft_id,o.status,o.provider_message_id,
        o.attempts,o.error_code,o.updated_at,o.delivered_at,o.read_at
 FROM public.outbound_message_deliveries AS o
 JOIN public.ai_drafts AS d ON d.id=o.draft_id AND d.organization_id=o.organization_id
 WHERE d.organization_id=p_organization_id AND o.organization_id=p_organization_id
 AND o.draft_id=ANY(p_draft_ids)
 ORDER BY o.draft_id,o.id;
 -- RETURN QUERY buffers in PL/pgSQL; a later exception discards all rows.
 -- Recheck after query/lock waits, including elapsed assertion/session deadlines.
 PERFORM sso.require_actor(p_organization_id,false);
 IF public.is_feature_enabled(p_organization_id,'ai_draft_generation') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Feature unavailable' USING ERRCODE='42501';
 END IF;
 -- The feature lookup may itself wait; validate temporal/session state last.
 PERFORM sso.require_session();
END $$;
ALTER FUNCTION public.sso_get_outbound_delivery_for_draft(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.sso_list_outbound_deliveries_for_drafts(uuid,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sso_get_outbound_delivery_for_draft(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,sso_control;
REVOKE ALL ON FUNCTION public.sso_list_outbound_deliveries_for_drafts(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role,sso_control;
GRANT EXECUTE ON FUNCTION public.sso_get_outbound_delivery_for_draft(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sso_list_outbound_deliveries_for_drafts(uuid,uuid[]) TO authenticated;
-- Fail closed on unexpected creator-default grants; do not repair shared defaults.
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_proc AS p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) AS a
  WHERE p.oid IN ('public.sso_get_outbound_delivery_for_draft(uuid,uuid)'::regprocedure,
                  'public.sso_list_outbound_deliveries_for_drafts(uuid,uuid[])'::regprocedure)
    AND ((a.grantee<>p.proowner AND a.grantee<>'authenticated'::regrole)
         OR (a.grantee='authenticated'::regrole AND a.is_grantable))
 ) THEN RAISE EXCEPTION 'Unexpected delivery wrapper ACL' USING ERRCODE='42501'; END IF;
END $$;
-- END P2-DB-01
COMMIT;
