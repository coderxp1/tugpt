-- B4: platform OAuth client metadata + pending authorizations.
--
-- Mirrors the customer track's mcp_oauth_* tables (A2) for the platform
-- registry: non-secret authorization-server/client metadata per platform
-- connection, and single-use pending rows holding only the SHA-256 of the
-- state plus the PKCE verifier. Service-side only (service_role); the
-- operator flow and the public callback both run server-side against these.

CREATE TABLE public.platform_oauth_clients (
  connection_id UUID PRIMARY KEY REFERENCES public.platform_connections(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_oauth_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.platform_connections(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  code_verifier TEXT NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at <= created_at + interval '15 minutes'),
  consumed_at TIMESTAMPTZ
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_oauth_clients', 'platform_oauth_pending']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;
