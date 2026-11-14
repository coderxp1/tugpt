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
-- Requires the complete exact baseline and committed RDB-1. No held product functions.
ALTER TABLE sso.tickets ADD COLUMN canonical_email text;
ALTER TABLE sso.sessions ADD COLUMN canonical_email text, ADD COLUMN email_verified_at timestamptz;
CREATE FUNCTION sso.issue_verified_ticket(p_hash text,p_subject uuid,p_auth_session uuid,p_token_exp bigint,p_token_iat bigint,p_canonical_email text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_canonical_email IS NOT NULL AND (length(p_canonical_email)>320 OR p_canonical_email !~ '^[^[:space:]@]+@[^[:space:]@]+$') THEN RAISE EXCEPTION 'Invalid email evidence' USING ERRCODE='22023'; END IF;
 IF NOT sso.issue_ticket(p_hash,p_subject,p_auth_session,p_token_exp,p_token_iat) THEN RETURN false; END IF;
 UPDATE sso.tickets SET canonical_email=p_canonical_email WHERE hash=p_hash;
 RETURN true;
END $$;
CREATE FUNCTION sso.require_session() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
BEGIN
 IF c->>'role' IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'Session required' USING ERRCODE='28000'; END IF;
 PERFORM sso.pre_request();
 PERFORM pg_advisory_xact_lock(hashtextextended((c->>'sub')||(c->>'session_id'),410));
 PERFORM 1 FROM sso.sessions WHERE hash=c->>'dash_session' FOR UPDATE;
 PERFORM sso.pre_request();
 IF (c->>'exp')::numeric<=extract(epoch from clock_timestamp()) OR NOT EXISTS(SELECT 1 FROM sso.sessions WHERE hash=c->>'dash_session' AND expires_at>clock_timestamp() AND revoked_at IS NULL) THEN RAISE EXCEPTION 'Session expired' USING ERRCODE='28000'; END IF;
 RETURN (c->>'sub')::uuid;
END $$;
CREATE OR REPLACE FUNCTION sso.consume_ticket(p_ticket_hash text,p_session_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t sso.tickets; v sso.sessions; BEGIN
 SELECT * INTO t FROM sso.tickets WHERE hash=p_ticket_hash;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.subject::text||t.auth_session::text,410));
 DELETE FROM sso.tickets WHERE hash=p_ticket_hash AND expires_at>clock_timestamp() RETURNING * INTO t;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM sso.revoked_auth_sessions WHERE subject=t.subject AND auth_session=t.auth_session) THEN RETURN NULL; END IF;
 -- Cap also binds to canonical token iat: replaying an unexpired old token cannot extend the 15-minute window.
 INSERT INTO sso.sessions(hash,subject,auth_session,issued_at,expires_at,canonical_email,email_verified_at)
 VALUES(p_session_hash,t.subject,t.auth_session,t.verified_at,t.session_deadline,t.canonical_email,CASE WHEN t.canonical_email IS NOT NULL THEN t.verified_at END) RETURNING * INTO v;
 RETURN jsonb_build_object('subject',v.subject,'auth_session',v.auth_session,'expires_at',v.expires_at);
END $$;
CREATE FUNCTION sso.require_actor(p_org uuid, p_write boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 v_actor uuid; v_role text;
BEGIN
 IF c->>'role' IS DISTINCT FROM 'authenticated' THEN
  RAISE EXCEPTION 'Session required' USING ERRCODE='28000'; END IF;
 PERFORM sso.pre_request();
 v_actor:=(c->>'sub')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended(v_actor::text||(c->>'session_id'),410));
 -- Row lock serializes app-only logout; canonical logout uses the advisory lock.
 PERFORM 1 FROM sso.sessions WHERE hash=c->>'dash_session' FOR UPDATE;
 PERFORM sso.pre_request();
 IF p_org IS NULL THEN RAISE EXCEPTION 'Organization required' USING ERRCODE='42501'; END IF;
 -- Fail without revealing whether the selected organization exists.
 IF NOT private.is_org_member(p_org,v_actor) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 PERFORM private.lock_organization_membership(p_org);
 v_role:=private.get_user_org_role(p_org,v_actor);
 IF v_role IS NULL OR (p_write AND v_role NOT IN ('owner','admin','manager','agent')) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF (c->>'exp')::numeric<=extract(epoch from clock_timestamp()) OR NOT EXISTS(
 SELECT 1 FROM sso.sessions WHERE hash=c->>'dash_session' AND expires_at>clock_timestamp() AND revoked_at IS NULL) THEN
 RAISE EXCEPTION 'Session expired' USING ERRCODE='28000'; END IF;
 RETURN v_actor;
END $$;
CREATE FUNCTION sso.feature_enabled(p_organization_id uuid,p_flag_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM sso.require_actor(p_organization_id,false);
 IF p_flag_key NOT IN ('media_generation','ai_draft_generation','google_calendar_freebusy') OR p_flag_key IS NULL THEN
  RAISE EXCEPTION 'Unsupported feature' USING ERRCODE='42501'; END IF;
 RETURN public.is_feature_enabled(p_organization_id,p_flag_key);
END $$;

-- Explicit per-signature ACLs, including internal-only helpers.
ALTER FUNCTION sso.issue_verified_ticket(text,uuid,uuid,bigint,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.issue_verified_ticket(text,uuid,uuid,bigint,bigint,text) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.require_session() OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.require_session() FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.consume_ticket(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.consume_ticket(text,text) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.require_actor(uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.require_actor(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.feature_enabled(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.feature_enabled(uuid,text) FROM PUBLIC,anon,authenticated,service_role,sso_control;
GRANT EXECUTE ON FUNCTION sso.issue_verified_ticket(text,uuid,uuid,bigint,bigint,text) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.consume_ticket(text,text) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.feature_enabled(uuid,text) TO authenticated;
COMMIT;
