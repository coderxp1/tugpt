-- ============================================================================
-- OAuth state consumption: one row per OAuth state that has been used.
-- (Phase 3, appointment availability — Google Calendar provisioning.)
--
-- WHY THIS TABLE EXISTS
--
-- The Google OAuth state is HMAC-signed, bound to the organization and
-- the initiating user, and expires after 10 minutes. Until now its
-- replay protection rested on Google's side: authorization codes are
-- single-use, so a captured callback URL dies with its code. That left
-- one gap — within the 10-minute window, the same state presented with
-- a DIFFERENT valid code (for example a second consent by the same
-- admin) would complete twice. For a credential-provisioning flow,
-- "the signed token can be spent more than once" is the wrong shape.
--
-- completeGoogleOAuthCallback now consumes the state before exchanging
-- the code: it inserts sha256(state) here, and a unique violation is
-- INVALID_STATE. Consumption is deliberately BEFORE the exchange — a
-- failed exchange burns the state and the admin restarts the flow,
-- which fails closed; recording after success would reopen the window
-- for the whole exchange.
--
-- WHAT IS STORED
--
-- Only the SHA-256 of the state (the state itself is an HMAC-signed
-- blob; its hash is not reversible into anything usable), the
-- organization and user it was bound to, and its expiry. Rows are
-- garbage once expired: nothing reads them after the fact except the
-- uniqueness check, and a periodic delete of expired rows is safe at
-- any time (DELETE FROM public.oauth_state_nonces WHERE expires_at <
-- now()). No such janitor is wired up here; the table grows by one row
-- per completed-or-attempted consent, which is admin-paced traffic.
--
-- ACCESS
--
-- RLS + FORCE RLS with no policies, exactly like the secrets tables:
-- only the service role (the OAuth callback path) touches this table,
-- and no browser role can read which states were spent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.oauth_state_nonces (
  state_hash TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS oauth_state_nonces_expires_at_idx
  ON public.oauth_state_nonces (expires_at);

ALTER TABLE public.oauth_state_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_state_nonces FORCE ROW LEVEL SECURITY;

-- The callback path writes as service_role; the grant is explicit (the
-- secret tables do the same) rather than left to image default
-- privileges. No UPDATE: a spend is immutable. DELETE exists for the
-- expired-row cleanup described above. Browser roles get no grant at
-- all, and RLS would refuse them regardless.
GRANT SELECT, INSERT, DELETE ON public.oauth_state_nonces TO service_role;

COMMENT ON TABLE public.oauth_state_nonces IS
  'Spent Google OAuth states (sha256 of the state blob). Inserted by completeGoogleOAuthCallback before the code exchange; a duplicate insert is a replay and is refused as INVALID_STATE. Rows are deletable once expires_at passes.';
