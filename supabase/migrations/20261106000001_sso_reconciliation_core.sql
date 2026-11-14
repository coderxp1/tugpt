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
CREATE SCHEMA sso;
REVOKE ALL ON SCHEMA sso FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sso_control') THEN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sso_control' AND
      (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='sso_control'::regrole OR member='sso_control'::regrole) THEN
   RAISE EXCEPTION 'sso_control role drift';
  END IF;
 ELSE
  CREATE ROLE sso_control NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
 END IF;
END $$;
REVOKE ALL ON SCHEMA sso FROM sso_control;
GRANT USAGE ON SCHEMA sso TO sso_control,authenticated;
-- Only new-schema defaults: never change shared public/private defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sso REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sso REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon,authenticated,service_role,sso_control;
-- Global default PUBLIC EXECUTE is neutralized by each explicit revoke below.
-- Later objects still require explicit ACL review; no future blanket grant.
CREATE TABLE sso.identity_bindings (
 canonical_sub uuid PRIMARY KEY, dashboard_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id),
 canonical_issuer text NOT NULL CHECK(canonical_issuer='https://rbiumegrwtavmljxbknp.supabase.co/auth/v1'),
 reviewed_at timestamptz NOT NULL DEFAULT now(), CHECK(canonical_sub=dashboard_user_id)
);
-- Populate bindings only after explicit UUID provenance approval. No email matching or account creation.
CREATE TABLE sso.revoked_auth_sessions (subject uuid NOT NULL, auth_session uuid NOT NULL, revoked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(subject,auth_session));
CREATE TABLE sso.tickets (hash text PRIMARY KEY CHECK(hash ~ '^[0-9a-f]{64}$'), subject uuid NOT NULL, auth_session uuid NOT NULL, expires_at timestamptz NOT NULL, verified_at timestamptz NOT NULL DEFAULT clock_timestamp(), session_deadline timestamptz NOT NULL);
CREATE TABLE sso.sessions (hash text PRIMARY KEY CHECK(hash ~ '^[0-9a-f]{64}$'), subject uuid NOT NULL, auth_session uuid NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE INDEX ON sso.sessions(subject,auth_session);
CREATE INDEX ON sso.sessions(expires_at);
CREATE INDEX ON sso.tickets(expires_at);
CREATE TABLE sso.rate_limits (bucket text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['identity_bindings','revoked_auth_sessions','tickets','sessions','rate_limits'] LOOP
 EXECUTE format('ALTER TABLE sso.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE sso.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON sso.%I FROM PUBLIC,anon,authenticated,service_role,sso_control',t);
END LOOP; END $$;
CREATE FUNCTION sso.limit_request(p_bucket text,p_limit integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; BEGIN
 IF length(p_bucket)>150 OR p_limit NOT BETWEEN 1 AND 120 THEN RETURN false; END IF;
 INSERT INTO sso.rate_limits VALUES(p_bucket,clock_timestamp(),1)
 ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN sso.rate_limits.window_start<clock_timestamp()-interval '1 minute' THEN 1 ELSE sso.rate_limits.attempts+1 END,
 window_start=CASE WHEN sso.rate_limits.window_start<clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE sso.rate_limits.window_start END RETURNING attempts INTO n;
 RETURN n<=p_limit;
END $$;
CREATE FUNCTION sso.issue_ticket(p_hash text,p_subject uuid,p_auth_session uuid,p_token_exp bigint,p_token_iat bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_subject::text||p_auth_session::text,410));
 IF p_token_iat IS NULL OR p_token_exp IS NULL OR p_token_iat>extract(epoch from clock_timestamp()) OR p_token_iat+900<=extract(epoch from clock_timestamp()) OR p_token_exp<=extract(epoch from clock_timestamp()) OR EXISTS(SELECT 1 FROM sso.revoked_auth_sessions WHERE subject=p_subject AND auth_session=p_auth_session) THEN RETURN false; END IF;
 INSERT INTO sso.tickets(hash,subject,auth_session,expires_at,session_deadline) VALUES(p_hash,p_subject,p_auth_session,least(clock_timestamp()+interval '30 seconds',to_timestamp(p_token_exp),to_timestamp(p_token_iat+900)),least(clock_timestamp()+interval '15 minutes',to_timestamp(p_token_exp),to_timestamp(p_token_iat+900)));
 RETURN true;
END $$;
CREATE FUNCTION sso.consume_ticket(p_ticket_hash text,p_session_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t sso.tickets; v sso.sessions; BEGIN
 SELECT * INTO t FROM sso.tickets WHERE hash=p_ticket_hash;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t.subject::text||t.auth_session::text,410));
 DELETE FROM sso.tickets WHERE hash=p_ticket_hash AND expires_at>clock_timestamp() RETURNING * INTO t;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM sso.revoked_auth_sessions WHERE subject=t.subject AND auth_session=t.auth_session) THEN RETURN NULL; END IF;
 -- Cap also binds to canonical token iat: replaying an unexpired old token cannot extend the 15-minute window.
 INSERT INTO sso.sessions(hash,subject,auth_session,issued_at,expires_at)
 VALUES(p_session_hash,t.subject,t.auth_session,t.verified_at,t.session_deadline) RETURNING * INTO v;
 RETURN jsonb_build_object('subject',v.subject,'auth_session',v.auth_session,'expires_at',v.expires_at);
END $$;
CREATE FUNCTION sso.load_session(p_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('subject',s.subject,'auth_session',s.auth_session,'expires_at',s.expires_at,
 'mapped',EXISTS(SELECT 1 FROM sso.identity_bindings b WHERE b.canonical_sub=s.subject))
 FROM sso.sessions s WHERE s.hash=p_hash AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND NOT EXISTS(SELECT 1 FROM sso.revoked_auth_sessions r WHERE r.subject=s.subject AND r.auth_session=s.auth_session);
$$;
CREATE FUNCTION sso.logout_session(p_hash text,p_ticket_hash text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 UPDATE sso.sessions SET revoked_at=clock_timestamp() WHERE hash=p_hash AND revoked_at IS NULL;
 DELETE FROM sso.tickets WHERE hash=p_ticket_hash;
END $$;
CREATE FUNCTION sso.revoke_auth_session(p_subject uuid,p_auth_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_subject::text||p_auth_session::text,410));
 INSERT INTO sso.revoked_auth_sessions(subject,auth_session) VALUES(p_subject,p_auth_session) ON CONFLICT DO NOTHING;
 UPDATE sso.sessions SET revoked_at=clock_timestamp() WHERE subject=p_subject AND auth_session=p_auth_session AND revoked_at IS NULL;
 DELETE FROM sso.tickets WHERE subject=p_subject AND auth_session=p_auth_session;
END $$;
CREATE FUNCTION sso.pre_request() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c jsonb:=nullif(current_setting('request.jwt.claims',true),'')::jsonb; BEGIN
 IF c->>'iss' IS DISTINCT FROM 'urn:tugpt:dashboard:bridge' OR c->>'aud' IS DISTINCT FROM 'tugpt-dashboard-db' OR
 c->>'role' NOT IN ('authenticated','sso_control') OR c->>'role' IS NULL OR
 (c->>'iat')::numeric>extract(epoch from statement_timestamp()) OR (c->>'exp')::numeric<=(c->>'iat')::numeric OR (c->>'exp')::numeric<=extract(epoch from statement_timestamp()) OR (c->>'exp')::numeric-(c->>'iat')::numeric>60 OR c->>'iat' IS NULL OR c->>'exp' IS NULL THEN
 RAISE EXCEPTION 'Invalid database assertion' USING ERRCODE='28000'; END IF;
 IF c->>'role'='authenticated' AND NOT EXISTS(
 SELECT 1 FROM sso.sessions s JOIN sso.identity_bindings b ON b.canonical_sub=s.subject
 WHERE s.hash=c->>'dash_session' AND s.subject=(c->>'sub')::uuid AND s.auth_session=(c->>'session_id')::uuid
 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND NOT EXISTS(SELECT 1 FROM sso.revoked_auth_sessions r WHERE r.subject=s.subject AND r.auth_session=s.auth_session)) THEN
 RAISE EXCEPTION 'Dashboard session unavailable' USING ERRCODE='28000'; END IF;
END $$;
CREATE FUNCTION sso.cleanup_expired() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM sso.tickets WHERE expires_at<clock_timestamp()-interval '1 day';
 DELETE FROM sso.sessions WHERE expires_at<clock_timestamp()-interval '1 day';
 DELETE FROM sso.rate_limits WHERE window_start<clock_timestamp()-interval '1 day';
 -- Revocation tombstones are deliberately retained; deleting them could permit replay.
END $$;

-- Explicit per-signature ACLs, including internal-only helpers.
ALTER FUNCTION sso.limit_request(text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.limit_request(text,integer) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.issue_ticket(text,uuid,uuid,bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.issue_ticket(text,uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.consume_ticket(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.consume_ticket(text,text) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.load_session(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.load_session(text) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.logout_session(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.logout_session(text,text) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.revoke_auth_session(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.revoke_auth_session(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.pre_request() OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.pre_request() FROM PUBLIC,anon,authenticated,service_role,sso_control;
ALTER FUNCTION sso.cleanup_expired() OWNER TO postgres;
REVOKE ALL ON FUNCTION sso.cleanup_expired() FROM PUBLIC,anon,authenticated,service_role,sso_control;
GRANT EXECUTE ON FUNCTION sso.limit_request(text,integer) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.consume_ticket(text,text) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.load_session(text) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.logout_session(text,text) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.revoke_auth_session(uuid,uuid) TO sso_control;
GRANT EXECUTE ON FUNCTION sso.pre_request() TO sso_control;
GRANT EXECUTE ON FUNCTION sso.pre_request() TO authenticated;
-- No authenticator membership, gateway changes, binding population or scheduler.
COMMIT;
