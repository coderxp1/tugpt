-- Dashboard Backend M1 (Agent 7): team and organization management.
--
-- WHAT THIS CHANGES
--
-- 1. public.manage_organization_member keeps its signature (callers and
--    generated types are unaffected) but its rules are tightened:
--
--    a. 'add' is refused for every caller. Membership is granted only through
--       an invitation, which carries the invitee's consent and a verified email
--       (accept_invitation). The previous 'add' let any owner/admin attach ANY
--       user id to their organization. User ids are not secrets (they are
--       visible to co-members in every organization a person belongs to), and
--       a forced membership makes the victim's profile - email and name -
--       readable to the attacker's organization through the co-member profile
--       policy. Nothing in the application called 'add'.
--
--    b. Rank: an admin may manage only members strictly below admin
--       (manager/agent/viewer) and may assign at most 'admin'. Owners may
--       manage anyone, including other owners; the last-owner trigger
--       (private.prevent_last_owner_removal, P3S05) still applies. Previously
--       admins could demote or remove other admins.
--
--    c. 'Member not found' gets its own code (P3S06) so the API can answer 404,
--       and the new peer-admin rank refusals get P3S07 so the screen can say
--       why. An admin touching an owner keeps the existing P3S02.
--
--    d. A set_role to the role the member already has changes nothing and
--       writes no audit row.
--
--    e. Self-removal is audited as 'membership.leave' (previously
--       'membership.remove', indistinguishable from being removed).
--
-- 2. public.update_organization_settings: the audited, validated way to change
--    an organization's name, locale and time zone. Direct UPDATE on
--    public.organizations is revoked from authenticated so the audit trail
--    cannot be bypassed through PostgREST. No application code used it.
--
-- Profiles need nothing here: authenticated already holds column-level
-- UPDATE(full_name, avatar_url, preferred_locale) on public.profiles with an
-- own-row policy (20261102000002), which the Dashboard API reuses.
--
-- Review candidate: production approval required.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION public.manage_organization_member(p_organization_id uuid,p_user_id uuid,p_action text,p_role public.organization_role DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_actor uuid:=auth.uid();
 v_actor_role public.organization_role;
 v_old public.organization_role;
 v_self boolean;
 v_audit_action text;
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='P3S01'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('add','set_role','remove') OR p_user_id IS NULL THEN
  RAISE EXCEPTION 'Invalid membership action' USING ERRCODE='P3S03'; END IF;
 IF p_organization_id IS NULL OR NOT private.is_org_member(p_organization_id,v_actor) THEN
  RAISE EXCEPTION 'Organization not found' USING ERRCODE='P3S01'; END IF;
 IF p_action='add' THEN
  RAISE EXCEPTION 'Members join through invitations' USING ERRCODE='P3S02'; END IF;

 PERFORM private.lock_organization_membership(p_organization_id);
 -- Re-read under the lock: the actor may have been demoted or removed meanwhile.
 v_actor_role:=private.get_user_org_role(p_organization_id,v_actor);
 IF v_actor_role IS NULL THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='P3S01'; END IF;
 SELECT role INTO v_old FROM public.organization_members
  WHERE organization_id=p_organization_id AND user_id=p_user_id FOR UPDATE;
 v_self:=(p_user_id=v_actor);

 IF NOT (p_action='remove' AND v_self) THEN
  IF v_actor_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='P3S02'; END IF;
  IF v_old IS NULL THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P3S06'; END IF;
  -- Unchanged contract from 20261102000001: admins touching owners get P3S02.
  IF v_actor_role='admin' AND (v_old='owner' OR p_role='owner') THEN
   RAISE EXCEPTION 'Only owners may manage owners' USING ERRCODE='P3S02'; END IF;
  IF NOT v_self AND v_actor_role<>'owner' AND private.role_rank(v_old)>=private.role_rank(v_actor_role) THEN
   RAISE EXCEPTION 'Cannot manage a member at or above your own role' USING ERRCODE='P3S07'; END IF;
  IF p_action='set_role' THEN
   IF p_role IS NULL THEN RAISE EXCEPTION 'Role required' USING ERRCODE='P3S03'; END IF;
   IF private.role_rank(p_role)>private.role_rank(v_actor_role) THEN
    RAISE EXCEPTION 'Cannot assign a role above your own' USING ERRCODE='P3S07'; END IF;
  END IF;
 END IF;

 IF p_action='set_role' THEN
  IF v_old=p_role THEN
   RETURN jsonb_build_object('organization_id',p_organization_id,'user_id',p_user_id,'action',p_action,
    'previous_role',v_old,'role',p_role,'changed',false);
  END IF;
  UPDATE public.organization_members SET role=p_role,updated_at=pg_catalog.now()
   WHERE organization_id=p_organization_id AND user_id=p_user_id;
  v_audit_action:='membership.set_role';
 ELSE
  INSERT INTO public.conversation_events(organization_id,conversation_id,action,actor_id,subject_id,previous_status,new_status)
   SELECT organization_id,id,'unassign',v_actor,p_user_id,status,status FROM public.conversations
   WHERE organization_id=p_organization_id AND assigned_to=p_user_id;
  UPDATE public.conversations SET assigned_to=NULL,updated_at=pg_catalog.now()
   WHERE organization_id=p_organization_id AND assigned_to=p_user_id;
  DELETE FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_user_id;
  v_audit_action:=CASE WHEN v_self THEN 'membership.leave' ELSE 'membership.remove' END;
 END IF;

 INSERT INTO public.audit_logs(organization_id,user_id,action,resource,details)
 VALUES(p_organization_id,v_actor,v_audit_action,'organization_member',
  jsonb_build_object('subject_id',p_user_id,'previous_role',v_old,
   'role',CASE WHEN p_action='set_role' THEN p_role END,'actor_role',v_actor_role));

 RETURN jsonb_build_object('organization_id',p_organization_id,'user_id',p_user_id,'action',p_action,
  'previous_role',v_old,'role',CASE WHEN p_action='set_role' THEN p_role END,'changed',true);
END; $$;
REVOKE ALL ON FUNCTION public.manage_organization_member(uuid,uuid,text,public.organization_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_organization_member(uuid,uuid,text,public.organization_role) TO authenticated,service_role;

-- Organization settings -------------------------------------------------------
CREATE FUNCTION public.update_organization_settings(p_organization_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_actor uuid:=auth.uid();
 v_org public.organizations%ROWTYPE;
 v_name text; v_locale text; v_tz text;
 v_diff jsonb:='{}'::jsonb;
 v_key text;
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='P3S01'; END IF;
 IF p_organization_id IS NULL OR NOT private.is_org_member(p_organization_id,v_actor) THEN
  RAISE EXCEPTION 'Organization not found' USING ERRCODE='P3S01'; END IF;
 IF NOT private.has_org_role(p_organization_id,v_actor,ARRAY['owner','admin']::public.organization_role[]) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='P3S02'; END IF;
 IF p_changes IS NULL OR jsonb_typeof(p_changes)<>'object' OR p_changes='{}'::jsonb THEN
  RAISE EXCEPTION 'No changes' USING ERRCODE='P3S03'; END IF;
 FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
  IF v_key NOT IN ('name','locale','time_zone') THEN RAISE EXCEPTION 'Unknown setting' USING ERRCODE='P3S03'; END IF;
 END LOOP;

 SELECT * INTO v_org FROM public.organizations WHERE id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='P3S01'; END IF;

 v_name:=v_org.name; v_locale:=v_org.locale; v_tz:=v_org.time_zone;
 IF p_changes ? 'name' THEN
  IF jsonb_typeof(p_changes->'name')<>'string' THEN RAISE EXCEPTION 'Invalid name' USING ERRCODE='P3S03'; END IF;
  v_name:=btrim(p_changes->>'name');
  IF v_name='' OR char_length(v_name)>120 OR v_name ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid name' USING ERRCODE='P3S03'; END IF;
 END IF;
 IF p_changes ? 'locale' THEN
  IF jsonb_typeof(p_changes->'locale')<>'string' OR (p_changes->>'locale') NOT IN ('es','en') THEN
   RAISE EXCEPTION 'Invalid locale' USING ERRCODE='P3S03'; END IF;
  v_locale:=p_changes->>'locale';
 END IF;
 IF p_changes ? 'time_zone' THEN
  IF jsonb_typeof(p_changes->'time_zone')='null' THEN v_tz:=NULL;
  ELSIF jsonb_typeof(p_changes->'time_zone')<>'string' OR NOT private.is_valid_iana_time_zone(p_changes->>'time_zone') THEN
   RAISE EXCEPTION 'Invalid time zone' USING ERRCODE='P3S03';
  ELSE v_tz:=p_changes->>'time_zone'; END IF;
 END IF;

 IF v_name IS DISTINCT FROM v_org.name THEN v_diff:=v_diff||jsonb_build_object('name',jsonb_build_object('from',v_org.name,'to',v_name)); END IF;
 IF v_locale IS DISTINCT FROM v_org.locale THEN v_diff:=v_diff||jsonb_build_object('locale',jsonb_build_object('from',v_org.locale,'to',v_locale)); END IF;
 IF v_tz IS DISTINCT FROM v_org.time_zone THEN v_diff:=v_diff||jsonb_build_object('time_zone',jsonb_build_object('from',v_org.time_zone,'to',v_tz)); END IF;

 IF v_diff<>'{}'::jsonb THEN
  UPDATE public.organizations SET name=v_name,locale=v_locale,time_zone=v_tz WHERE id=p_organization_id;
  INSERT INTO public.audit_logs(organization_id,user_id,action,resource,details)
  VALUES(p_organization_id,v_actor,'organization.update_settings','organization',jsonb_build_object('changes',v_diff));
 END IF;

 RETURN jsonb_build_object('id',v_org.id,'name',v_name,'slug',v_org.slug,'locale',v_locale,'time_zone',v_tz,
  'changed',v_diff<>'{}'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION public.update_organization_settings(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_organization_settings(uuid,jsonb) TO authenticated,service_role;

-- The audited RPC above is now the only browser-session path for settings.
REVOKE UPDATE ON public.organizations FROM authenticated;

COMMIT;
