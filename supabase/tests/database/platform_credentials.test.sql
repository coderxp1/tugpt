-- platform_credentials.test.sql
-- B2 (ADR-022 D2): platform ciphertext lives in its own table, broker-only;
-- no org column; service_role and org roles get nothing; the audit log
-- accepts the 'platform' caller identity.
BEGIN;
SELECT plan(10);

INSERT INTO public.platform_connections (id, provider_key, credential_kind, status) VALUES
  ('d7000000-0000-4000-8000-0000000ca001', 'heygen', 'oauth_token_set', 'connected');

SELECT ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_connection_credentials' AND column_name = 'organization_id'),
  'S1: platform ciphertext has no organization_id');
SELECT ok(has_table_privilege('connect_broker', 'public.platform_connection_credentials', 'SELECT')
      AND has_table_privilege('connect_broker', 'public.platform_connection_credentials', 'INSERT')
      AND has_table_privilege('connect_broker', 'public.platform_connection_credentials', 'UPDATE')
      AND has_table_privilege('connect_broker', 'public.platform_connection_credentials', 'DELETE'),
  'A1: connect_broker has full ciphertext access');
SELECT ok(NOT has_table_privilege('service_role', 'public.platform_connection_credentials', 'SELECT'),
  'A2: service_role has NO access to platform ciphertext');
SELECT ok(NOT has_table_privilege('authenticated', 'public.platform_connection_credentials', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.platform_connection_credentials', 'SELECT'),
  'A3: org roles have no access to platform ciphertext');
SELECT ok(has_column_privilege('connect_broker', 'public.platform_connections', 'status', 'UPDATE')
      AND NOT has_column_privilege('connect_broker', 'public.platform_connections', 'provider_key', 'UPDATE'),
  'A4: the broker may update platform connection status only, not identity columns');

SET LOCAL ROLE connect_broker;
INSERT INTO public.platform_connection_credentials (connection_id, kind, credential_version, key_id, iv, ciphertext, auth_tag) VALUES
  ('d7000000-0000-4000-8000-0000000ca001', 'oauth_token_set', 1, 'org.v1', decode('000102030405060708090a0b', 'hex'), decode('deadbeef', 'hex'), decode('00112233445566778899aabbccddeeff', 'hex'));
SELECT ok(EXISTS (SELECT 1 FROM public.platform_connection_credentials WHERE connection_id = 'd7000000-0000-4000-8000-0000000ca001'),
  'B1: the broker can store and read platform ciphertext');
SELECT throws_ok($$INSERT INTO public.platform_connection_credentials (connection_id, kind, credential_version, key_id, iv, ciphertext, auth_tag) VALUES
  ('d7000000-0000-4000-8000-0000000ca001', 'oauth_token_set', 2, 'org.v1', decode('000102030405060708090a0b', 'hex'), decode('beef', 'hex'), decode('00112233445566778899aabbccddeeff', 'hex'))$$,
  '23505', NULL, 'B2: (key_id, iv) nonce reuse is impossible to store');
RESET ROLE;

-- audit caller identity
INSERT INTO public.credential_access_log (request_id, caller, operation, organization_id, connection_id, outcome) VALUES
  (gen_random_uuid(), 'platform', 'get_access_token', NULL, 'd7000000-0000-4000-8000-0000000ca001', 'ok');
SELECT ok(EXISTS (SELECT 1 FROM public.credential_access_log WHERE caller = 'platform' AND organization_id IS NULL),
  'B3: platform audit entries carry the platform caller and no organization');
SELECT throws_ok($$INSERT INTO public.credential_access_log (request_id, caller, operation, outcome) VALUES
  (gen_random_uuid(), 'intruder', 'get_access_token', 'ok')$$,
  '23514', NULL, 'B4: unknown caller identities are still refused');

-- deleting the platform connection cascades the ciphertext away
DELETE FROM public.platform_connections WHERE id = 'd7000000-0000-4000-8000-0000000ca001';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.platform_connection_credentials WHERE connection_id = 'd7000000-0000-4000-8000-0000000ca001'),
  'B5: platform connection deletion cascades to its ciphertext');

SELECT * FROM finish();
ROLLBACK;
