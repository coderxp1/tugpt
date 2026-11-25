-- platform_oauth.test.sql
-- B4: platform OAuth metadata/pending tables are service-side only, bound to
-- platform connections, with hashed single-use state.
BEGIN;
SELECT plan(8);

INSERT INTO public.platform_connections (id, provider_key, credential_kind, status) VALUES
  ('d9000000-0000-4000-8000-0000000ca001', 'heygen', 'oauth_token_set', 'requires_authorization');

SELECT ok(NOT has_table_privilege('authenticated', 'public.platform_oauth_clients', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.platform_oauth_pending', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.platform_oauth_pending', 'SELECT'),
  'A1: org roles have no access to platform OAuth tables');
SELECT ok(has_table_privilege('service_role', 'public.platform_oauth_clients', 'SELECT')
      AND has_table_privilege('service_role', 'public.platform_oauth_pending', 'UPDATE'),
  'A2: service_role (server-side flows) has access');

SET LOCAL ROLE service_role;
INSERT INTO public.platform_oauth_clients (connection_id, issuer, authorization_endpoint, token_endpoint, client_id, resource) VALUES
  ('d9000000-0000-4000-8000-0000000ca001', 'https://auth.example.test', 'https://auth.example.test/authorize', 'https://auth.example.test/token', 'client-1', 'https://mcp.example.test/mcp');
INSERT INTO public.platform_oauth_pending (connection_id, state_hash, code_verifier, expires_at) VALUES
  ('d9000000-0000-4000-8000-0000000ca001', repeat('a', 64), repeat('v', 43), now() + interval '10 minutes');
SELECT ok(EXISTS (SELECT 1 FROM public.platform_oauth_pending WHERE connection_id = 'd9000000-0000-4000-8000-0000000ca001'),
  'B1: a pending authorization can be recorded');
SELECT throws_ok($$INSERT INTO public.platform_oauth_pending (connection_id, state_hash, code_verifier, expires_at) VALUES
  ('d9000000-0000-4000-8000-0000000ca001', repeat('a', 64), repeat('w', 43), now() + interval '10 minutes')$$,
  '23505', NULL, 'B2: state hashes are unique');
SELECT throws_ok($$INSERT INTO public.platform_oauth_pending (connection_id, state_hash, code_verifier, expires_at) VALUES
  ('d9000000-0000-4000-8000-0000000ca001', repeat('b', 64), repeat('w', 43), now() + interval '30 minutes')$$,
  '23514', NULL, 'B3: pending lifetime is capped at 15 minutes');
SELECT throws_ok($$INSERT INTO public.platform_oauth_pending (connection_id, state_hash, code_verifier, expires_at) VALUES
  ('d9000000-0000-4000-8000-0000000ca001', 'raw-state-not-hashed', repeat('w', 43), now() + interval '10 minutes')$$,
  '23514', NULL, 'B4: only hashed state can be stored');
RESET ROLE;

DELETE FROM public.platform_connections WHERE id = 'd9000000-0000-4000-8000-0000000ca001';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.platform_oauth_clients WHERE connection_id = 'd9000000-0000-4000-8000-0000000ca001')
      AND NOT EXISTS (SELECT 1 FROM public.platform_oauth_pending WHERE connection_id = 'd9000000-0000-4000-8000-0000000ca001'),
  'B5: deleting a platform connection cascades its OAuth rows');

SELECT * FROM finish();
ROLLBACK;
