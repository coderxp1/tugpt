-- Migration 20261120000012: durable broker credential store.
-- `connect_broker` (NOLOGIN; a login member is provisioned out of band) owns ciphertext
-- access; `service_role` (the web app's key) and browser roles hold nothing on it.
BEGIN;
SELECT plan(22);

-- Role and column
SELECT has_role('connect_broker', 'connect_broker role exists');
SELECT ok(NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'connect_broker'), 'the migration never grants LOGIN (a login member is provisioned out of band)');
SELECT ok(NOT (SELECT rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = 'connect_broker'), 'connect_broker has no BYPASSRLS/SUPERUSER/CREATEROLE/CREATEDB');
SELECT has_column('public', 'connected_accounts', 'credential_kind', 'connected_accounts.credential_kind exists');
SELECT col_not_null('public', 'connected_accounts', 'credential_kind', 'credential_kind is NOT NULL');

-- Ciphertext table: exactly S/I/U/D for the broker, nothing for anyone else
SELECT is((SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
           WHERE has_table_privilege('connect_broker', 'public.connected_account_credentials', p)),
          'DELETE,INSERT,SELECT,UPDATE', 'connect_broker: exactly SELECT, INSERT, UPDATE, DELETE on ciphertext');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
           WHERE has_table_privilege('service_role', 'public.connected_account_credentials', p)), 0, 'service_role holds nothing on ciphertext');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['authenticated','anon']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
           WHERE has_table_privilege(r, 'public.connected_account_credentials', p)), 0, 'authenticated and anon hold nothing on ciphertext');

-- Connection rows: read a few columns, update only status fields
SELECT ok(has_column_privilege('connect_broker', 'public.connected_accounts', 'credential_kind', 'SELECT'), 'broker reads credential_kind');
SELECT ok(has_column_privilege('connect_broker', 'public.connected_accounts', 'status', 'UPDATE'), 'broker updates status');
SELECT ok(has_column_privilege('connect_broker', 'public.connected_accounts', 'revoked_at', 'UPDATE'), 'broker sets revoked_at');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['organization_id','provider_key','owner_type','owner_user_id','credential_kind','created_by','id']) c
           WHERE has_column_privilege('connect_broker', 'public.connected_accounts', c, 'UPDATE')), 0, 'broker cannot change identity, ownership or kind columns');
SELECT ok(NOT has_column_privilege('connect_broker', 'public.connected_accounts', 'display_name', 'SELECT'), 'broker does not read display_name');
SELECT is((SELECT count(*)::int FROM unnest(ARRAY['INSERT','DELETE','TRUNCATE']) p
           WHERE has_table_privilege('connect_broker', 'public.connected_accounts', p)), 0, 'broker cannot insert, delete or truncate connections');
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
           AND c.relname NOT IN ('connected_accounts','connected_account_credentials')
           AND (has_table_privilege('connect_broker', c.oid, 'SELECT') OR has_table_privilege('connect_broker', c.oid, 'INSERT')
             OR has_table_privilege('connect_broker', c.oid, 'UPDATE') OR has_table_privilege('connect_broker', c.oid, 'DELETE'))), 0,
          'broker touches no other public table');

-- Behaviour under RLS (FORCE RLS is on for both tables)
INSERT INTO public.organizations (id, name, slug) VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'broker-tap-a', 'broker-tap-a');
INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type)
  VALUES ('c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-00000000000a', 'google', 'organization');

SET LOCAL ROLE connect_broker;
SELECT lives_ok($$INSERT INTO public.connected_account_credentials (connection_id, organization_id, kind, credential_version, key_id, iv, ciphertext, auth_tag)
  VALUES ('c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-00000000000a', 'oauth_token_set', 1, 'org.v1', '\x000000000000000000000000', '\x01', '\x00000000000000000000000000000000')$$,
  'broker inserts a credential row');
SELECT is((SELECT credential_version FROM public.connected_account_credentials WHERE connection_id = 'c0000000-0000-4000-8000-0000000000c1'), 1, 'broker reads it back');
SELECT lives_ok($$UPDATE public.connected_accounts SET status = 'connected', updated_at = now() WHERE id = 'c0000000-0000-4000-8000-0000000000c1'$$, 'broker updates status');
SELECT throws_ok($$UPDATE public.connected_accounts SET provider_key = 'microsoft' WHERE id = 'c0000000-0000-4000-8000-0000000000c1'$$, '42501', NULL, 'broker cannot re-point a connection');
SELECT throws_ok($$DELETE FROM public.connected_accounts WHERE id = 'c0000000-0000-4000-8000-0000000000c1'$$, '42501', NULL, 'broker cannot delete a connection');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT ciphertext FROM public.connected_account_credentials$$, '42501', NULL, 'service_role cannot read ciphertext');
SELECT throws_ok($$DELETE FROM public.connected_account_credentials$$, '42501', NULL, 'service_role cannot delete ciphertext');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
