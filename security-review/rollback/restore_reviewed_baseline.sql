-- REVIEW ONLY: restores reviewed baseline and REOPENS F1-F4. Separate approval required.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DROP TRIGGER enforce_conversation_assignment ON public.conversations;
DROP FUNCTION private.enforce_conversation_assignment();
DROP FUNCTION public.manage_organization_member(uuid,uuid,text,public.organization_role);
DROP FUNCTION public.transfer_organization_ownership(uuid,uuid);
DROP TRIGGER trigger_prevent_last_owner_removal ON public.organization_members;
CREATE OR REPLACE FUNCTION private.prevent_last_owner_removal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_owner_count INTEGER;
BEGIN
  -- If the organization itself is being deleted (hard delete cascade), bypass check
  IF current_query() ~* 'delete\s+from\s+(\w+\.)?organizations' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  IF (TG_OP = 'DELETE' AND OLD.role = 'owner') OR 
     (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner') THEN
    
    SELECT COUNT(*) INTO v_owner_count
    FROM public.organization_members
    WHERE organization_id = OLD.organization_id
      AND role = 'owner'
      AND user_id <> OLD.user_id;

    IF v_owner_count = 0 THEN
      RAISE EXCEPTION 'Action blocked: An organization must have at least one active owner';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$
;
CREATE OR REPLACE FUNCTION private.accept_invitation(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
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

  SELECT lower(email) INTO v_email FROM public.profiles WHERE id = v_user;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P3D01';
  END IF;

  SELECT * INTO v_inv
  FROM public.organization_invitations
  WHERE token_hash = private.hash_invitation_token(p_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invitation' USING ERRCODE = 'P3D01';
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
$function$
;
CREATE OR REPLACE FUNCTION private.assign_conversation(p_conversation_id uuid, p_assignee uuid, p_expected_assignee uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_actor UUID := auth.uid();
  v_action TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  -- Locked, and the organization is read OFF THE ROW rather than taken from the
  -- caller. A caller that could supply the organization could supply someone
  -- else's, and every check below would then be asking the wrong question.
  SELECT * INTO v_conv
    FROM public.conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P3C01';
  END IF;

  IF NOT private.is_org_member(v_conv.organization_id, v_actor) THEN
    -- Deliberately the same answer a missing conversation gets. Whether a given
    -- id exists in some other tenant is not something an authenticated stranger
    -- gets to learn by watching which error comes back.
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE = 'P3C01';
  END IF;

  IF NOT private.has_org_role(v_conv.organization_id, v_actor,
       ARRAY['owner', 'admin', 'manager', 'agent']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  -- Compare-and-set. IS DISTINCT FROM so that NULL means "I saw it unassigned"
  -- rather than "no opinion" — see the header.
  IF v_conv.assigned_to IS DISTINCT FROM p_expected_assignee THEN
    RAISE EXCEPTION 'ASSIGNMENT_CONFLICT' USING ERRCODE = 'P3C04';
  END IF;

  IF p_assignee IS NOT NULL THEN
    -- The assignee must be a member of THIS organization. Without this check a
    -- reviewer could park a customer conversation on a stranger's id, and that
    -- id would then appear on the row and in the event log.
    IF NOT private.is_org_member(v_conv.organization_id, p_assignee) THEN
      RAISE EXCEPTION 'ASSIGNEE_NOT_A_MEMBER' USING ERRCODE = 'P3C03';
    END IF;

    v_action := 'assign';
    UPDATE public.conversations
       SET assigned_to = p_assignee,
           updated_at  = pg_catalog.now()
     WHERE id = p_conversation_id;
  ELSE
    v_action := 'unassign';
    UPDATE public.conversations
       SET assigned_to = NULL,
           updated_at  = pg_catalog.now()
     WHERE id = p_conversation_id;
  END IF;

  INSERT INTO public.conversation_events
    (organization_id, conversation_id, action, actor_id, subject_id,
     previous_status, new_status)
  VALUES
    (v_conv.organization_id, p_conversation_id, v_action, v_actor, p_assignee,
     v_conv.status, v_conv.status);

  -- Deliberately narrow. `contact_phone` is on the row this function just
  -- locked, and a RETURNING * here would put it on the wire for an operation
  -- that has nothing to do with the customer's number.
  RETURN jsonb_build_object(
    'conversation_id', p_conversation_id,
    'status', v_conv.status,
    'assigned_to', p_assignee
  );
END;
$function$
;
CREATE TRIGGER trigger_prevent_last_owner_removal BEFORE DELETE OR UPDATE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION private.prevent_last_owner_removal();
DROP FUNCTION private.lock_organization_membership(uuid);
DROP TABLE private.membership_write_locks;
REVOKE UPDATE(full_name,avatar_url,preferred_locale) ON public.profiles FROM authenticated;
REVOKE INSERT(id,organization_id,whatsapp_connection_id,contact_phone,status,last_message_at,created_at,updated_at,activity_at,contact_id) ON public.conversations FROM authenticated;
REVOKE UPDATE(whatsapp_connection_id,contact_phone,status,last_message_at,updated_at,activity_at,contact_id) ON public.conversations FROM authenticated;
REVOKE ALL ON public.business_profiles FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.business_profiles TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.business_profiles TO authenticated;
REVOKE ALL ON public.audit_logs FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.audit_logs TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.audit_logs TO authenticated;
REVOKE ALL ON public.organizations FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.organizations TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.organizations TO authenticated;
REVOKE ALL ON public.feature_flags FROM PUBLIC,anon,authenticated;
GRANT INSERT,UPDATE,DELETE,MAINTAIN ON public.feature_flags TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.feature_flags TO authenticated;
REVOKE ALL ON public.conversations FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.conversations TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.conversations TO authenticated;
REVOKE ALL ON public.messages FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.messages TO anon;
GRANT SELECT,MAINTAIN ON public.messages TO authenticated;
REVOKE ALL ON public.ai_draft_configs FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.ai_draft_configs TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.ai_draft_configs TO authenticated;
REVOKE ALL ON public.ai_draft_review_events FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,MAINTAIN ON public.ai_draft_review_events TO anon;
GRANT INSERT,SELECT,MAINTAIN ON public.ai_draft_review_events TO authenticated;
REVOKE ALL ON public.conversation_events FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.conversation_events TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.conversation_events TO authenticated;
REVOKE ALL ON public.ai_draft_revisions FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.ai_draft_revisions TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.ai_draft_revisions TO authenticated;
REVOKE ALL ON public.ai_drafts FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.ai_drafts TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.ai_drafts TO authenticated;
REVOKE ALL ON public.organization_members FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.organization_members TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.organization_members TO authenticated;
REVOKE ALL ON public.profiles FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.profiles TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.profiles TO authenticated;
REVOKE ALL ON public.whatsapp_connections FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.whatsapp_connections TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.whatsapp_connections TO authenticated;
REVOKE ALL ON public.oauth_state_nonces FROM PUBLIC,anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.oauth_state_nonces TO anon;
GRANT INSERT,SELECT,UPDATE,DELETE,MAINTAIN ON public.oauth_state_nonces TO authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_invitation(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO anon;
REVOKE EXECUTE ON FUNCTION public.create_invitation(uuid,text,public.organization_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_invitation(uuid,text,public.organization_role) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_invitation(uuid,text,public.organization_role) TO anon;
REVOKE EXECUTE ON FUNCTION public.revoke_invitation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.revoke_invitation(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_invitation(uuid) TO anon;
REVOKE EXECUTE ON FUNCTION public.approve_and_enqueue_draft(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_and_enqueue_draft(uuid,integer) TO anon;
REVOKE EXECUTE ON FUNCTION public.approve_draft(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_draft(uuid,integer) TO anon;
REVOKE EXECUTE ON FUNCTION public.edit_draft(uuid,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.edit_draft(uuid,integer,text) TO anon;
REVOKE EXECUTE ON FUNCTION public.reject_draft(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reject_draft(uuid,integer) TO anon;
COMMIT;
