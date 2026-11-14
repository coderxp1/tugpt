-- Review candidate: production approval required. PostgreSQL 17+.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
REVOKE MAINTAIN ON public.ai_draft_configs,public.ai_draft_review_events,public.ai_draft_revisions,public.ai_drafts,public.audit_logs,public.business_profiles,public.conversation_events,public.conversations,public.feature_flags,public.messages,public.oauth_state_nonces,public.organization_members,public.organizations,public.profiles,public.whatsapp_connections FROM anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_invitation(text) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.create_invitation(uuid,text,public.organization_role) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.revoke_invitation(uuid) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.approve_and_enqueue_draft(uuid,integer) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.approve_draft(uuid,integer) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.edit_draft(uuid,integer,text) FROM PUBLIC,anon;
REVOKE EXECUTE ON FUNCTION public.reject_draft(uuid,integer) FROM PUBLIC,anon;
REVOKE ALL ON public.oauth_state_nonces FROM PUBLIC,anon,authenticated;
COMMIT;
