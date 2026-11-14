-- Review candidate: production approval required.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TABLE private.membership_write_locks(organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,revision bigint NOT NULL DEFAULT 0);
ALTER TABLE private.membership_write_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.membership_write_locks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.membership_write_locks FROM PUBLIC,anon,authenticated;
-- A real row UPDATE also detects stale repeatable-read snapshots.
CREATE FUNCTION private.lock_organization_membership(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 INSERT INTO private.membership_write_locks VALUES(p_org,1) ON CONFLICT(organization_id)
 DO UPDATE SET revision=private.membership_write_locks.revision+1;
$$;
REVOKE ALL ON FUNCTION private.lock_organization_membership(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.prevent_last_owner_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_org uuid;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
  RAISE EXCEPTION 'Membership identity is immutable' USING ERRCODE='P3S04'; END IF;
 v_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
 -- Permit only an actual parent-delete cascade, never a query-text exception.
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=v_org) THEN RETURN OLD; END IF;
 PERFORM private.lock_organization_membership(v_org);
 IF (TG_OP='DELETE' AND OLD.role='owner') OR (TG_OP='UPDATE' AND OLD.role='owner' AND NEW.role<>'owner') THEN
  IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=v_org AND role='owner' AND id<>OLD.id) THEN
   RAISE EXCEPTION 'An organization must retain an owner' USING ERRCODE='P3S05'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
DROP TRIGGER trigger_prevent_last_owner_removal ON public.organization_members;
CREATE TRIGGER trigger_prevent_last_owner_removal BEFORE INSERT OR UPDATE OR DELETE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION private.prevent_last_owner_removal();
REVOKE INSERT,UPDATE,DELETE ON public.organization_members FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.manage_organization_member(p_organization_id uuid,p_user_id uuid,p_action text,p_role public.organization_role DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_actor uuid:=auth.uid(); v_actor_role public.organization_role; v_old public.organization_role;
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='P3S01'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('add','set_role','remove') OR p_user_id IS NULL THEN RAISE EXCEPTION 'Invalid membership action' USING ERRCODE='P3S03'; END IF;
 IF NOT private.is_org_member(p_organization_id,v_actor) THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='P3S01'; END IF;
 PERFORM private.lock_organization_membership(p_organization_id);
 v_actor_role:=private.get_user_org_role(p_organization_id,v_actor);
 IF v_actor_role IS NULL THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE='P3S01'; END IF;
 SELECT role INTO v_old FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_user_id FOR UPDATE;
 IF NOT (p_action='remove' AND p_user_id=v_actor) THEN
  IF v_actor_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='P3S02'; END IF;
  IF v_actor_role='admin' AND (v_old='owner' OR p_role='owner') THEN RAISE EXCEPTION 'Only owners may manage owners' USING ERRCODE='P3S02'; END IF;
 END IF;
 IF p_action IN ('add','set_role') AND p_role IS NULL THEN RAISE EXCEPTION 'Role required' USING ERRCODE='P3S03'; END IF;
 IF p_action='add' THEN
  IF v_old IS NOT NULL THEN RAISE EXCEPTION 'Already a member' USING ERRCODE='P3S03'; END IF;
  INSERT INTO public.organization_members(organization_id,user_id,role) VALUES(p_organization_id,p_user_id,p_role);
 ELSIF p_action='set_role' THEN
  IF v_old IS NULL THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P3S03'; END IF;
  UPDATE public.organization_members SET role=p_role WHERE organization_id=p_organization_id AND user_id=p_user_id;
 ELSE
  IF v_old IS NULL THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P3S03'; END IF;
  INSERT INTO public.conversation_events(organization_id,conversation_id,action,actor_id,subject_id,previous_status,new_status)
   SELECT organization_id,id,'unassign',v_actor,p_user_id,status,status FROM public.conversations WHERE organization_id=p_organization_id AND assigned_to=p_user_id;
  UPDATE public.conversations SET assigned_to=NULL,updated_at=pg_catalog.now() WHERE organization_id=p_organization_id AND assigned_to=p_user_id;
  DELETE FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_user_id;
 END IF;
 INSERT INTO public.audit_logs(organization_id,user_id,action,resource,details) VALUES(p_organization_id,v_actor,'membership.'||p_action,'organization_member',jsonb_build_object('subject_id',p_user_id,'previous_role',v_old,'role',p_role));
 RETURN jsonb_build_object('organization_id',p_organization_id,'user_id',p_user_id,'action',p_action,'role',p_role);
END; $$;
REVOKE ALL ON FUNCTION public.manage_organization_member(uuid,uuid,text,public.organization_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_organization_member(uuid,uuid,text,public.organization_role) TO authenticated,service_role;
CREATE FUNCTION public.transfer_organization_ownership(p_organization_id uuid,p_new_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_actor uuid:=auth.uid();
BEGIN
 IF v_actor IS NULL OR NOT private.has_org_role(p_organization_id,v_actor,ARRAY['owner']::public.organization_role[]) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='P3S02'; END IF;
 PERFORM private.lock_organization_membership(p_organization_id);
 IF NOT private.has_org_role(p_organization_id,v_actor,ARRAY['owner']::public.organization_role[]) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='P3S02'; END IF;
 IF p_new_owner_id IS NULL OR p_new_owner_id=v_actor OR NOT private.is_org_member(p_organization_id,p_new_owner_id) THEN RAISE EXCEPTION 'New owner must be another existing member' USING ERRCODE='P3S03'; END IF;
 UPDATE public.organization_members SET role='owner' WHERE organization_id=p_organization_id AND user_id=p_new_owner_id;
 UPDATE public.organization_members SET role='admin' WHERE organization_id=p_organization_id AND user_id=v_actor;
 INSERT INTO public.audit_logs(organization_id,user_id,action,resource,details) VALUES(p_organization_id,v_actor,'organization.transfer_ownership','organization',jsonb_build_object('new_owner_id',p_new_owner_id));
 RETURN jsonb_build_object('organization_id',p_organization_id,'owner_id',p_new_owner_id);
END; $$;
REVOKE ALL ON FUNCTION public.transfer_organization_ownership(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.transfer_organization_ownership(uuid,uuid) TO authenticated,service_role;
COMMIT;
