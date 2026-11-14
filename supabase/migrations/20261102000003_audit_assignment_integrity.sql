-- Review candidate: production approval required.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Security audit records are emitted only by trusted server/definer code.
REVOKE INSERT,UPDATE,DELETE ON public.audit_logs FROM PUBLIC,anon,authenticated;
-- Column grants preserve ordinary creation/editing but reserve assignment for RPCs.
REVOKE INSERT,UPDATE ON public.conversations FROM PUBLIC,anon,authenticated;
GRANT INSERT(id,organization_id,whatsapp_connection_id,contact_phone,status,last_message_at,created_at,updated_at,activity_at,contact_id)
 ON public.conversations TO authenticated;
GRANT UPDATE(whatsapp_connection_id,contact_phone,status,last_message_at,updated_at,activity_at,contact_id)
 ON public.conversations TO authenticated;
CREATE FUNCTION private.enforce_conversation_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
  RAISE EXCEPTION 'Conversation organization is immutable' USING ERRCODE='P3S04'; END IF;
 IF NEW.assigned_to IS NOT NULL AND (TG_OP='INSERT' OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to) THEN
  PERFORM private.lock_organization_membership(NEW.organization_id);
  IF NOT private.is_org_member(NEW.organization_id,NEW.assigned_to) THEN
   RAISE EXCEPTION 'ASSIGNEE_NOT_A_MEMBER' USING ERRCODE='P3C03'; END IF;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.enforce_conversation_assignment() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER enforce_conversation_assignment BEFORE INSERT OR UPDATE ON public.conversations
 FOR EACH ROW EXECUTE FUNCTION private.enforce_conversation_assignment();
CREATE OR REPLACE FUNCTION private.assign_conversation(p_conversation_id uuid, p_assignee uuid, p_expected_assignee uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO pg_catalog
AS $function$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_actor UUID := auth.uid();
  v_action TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P3C02';
  END IF;

  -- Serialize with membership removal BEFORE taking a conversation row lock.
  -- Read organization from the row; deny outsiders before acquiring its guard.
  SELECT * INTO v_conv FROM public.conversations WHERE id=p_conversation_id;
  IF NOT FOUND OR NOT private.is_org_member(v_conv.organization_id,v_actor) THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='P3C01';
  END IF;
  PERFORM private.lock_organization_membership(v_conv.organization_id);
  -- Existing checks below re-read the row and recheck membership/role after lock.

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
COMMIT;
