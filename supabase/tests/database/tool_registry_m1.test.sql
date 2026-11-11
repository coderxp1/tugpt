-- tool_registry_m1.test.sql
--
-- ADR-020 M1. Four claims carry this file.
--
-- FAIL CLOSED (R1): a definition registered without an explicit availability
-- decision is invisible, not live. A catalogue that ships enabled is a
-- capability that ships on for every organization with no migration to review.
--
-- MEMBERSHIP IS THE GATE (M1-M2, X1-X2): discovery returns nothing for a
-- foreign organization, and the refusal is P4T01 — the same answer a
-- nonexistent organization gets, so ids cannot be enumerated. Anon cannot call
-- it at all.
--
-- THE GRANT IS THE BOUNDARY (G1-G4, M4-M5): neither browser role holds
-- anything on the catalogue, and authenticated holds SELECT only on grants. A
-- read policy without a matching privilege is inert; a privilege without a
-- policy is the whole table.
--
-- REVOCATION IS EVIDENCE (M2, K1): revoked grants stay as rows and are
-- excluded from discovery, and a definition cannot be deleted out from under a
-- grant.

BEGIN;
SELECT plan(30);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('11111111-f100-0000-0000-000000000001', 'member@espiga-f100.test'),
  ('11111111-f100-0000-0000-000000000002', 'outsider@tornillo-f100.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-f100-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-tool-test'),
  ('aaaaaaaa-f100-0000-0000-000000000002', 'Ferretería El Tornillo', 'tornillo-tool-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-f100-0000-0000-000000000001', '11111111-f100-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-f100-0000-0000-000000000002', '11111111-f100-0000-0000-000000000002', 'owner');

-- Three definitions with deliberately different states:
--   calendar.find_availability  available, granted          -> discovered
--   calendar.create_event       NOT available, granted      -> hidden
--   crm.link_activity           available, granted, revoked -> hidden
SELECT public.register_tool_definition(
  'calendar.find_availability', 1, 'Buscar disponibilidad',
  'Consulta la disponibilidad de la organización en el calendario conectado.',
  '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
  'read', 'derived', 'calendar.read', 15, true);

SELECT public.register_tool_definition(
  'calendar.create_event', 1, 'Crear evento',
  'Crea un evento en el calendario conectado de la organización.',
  '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
  'write', 'required', 'calendar.write', 30);

SELECT public.register_tool_definition(
  'crm.link_activity', 2, 'Vincular actividad',
  'Registra una actividad en el contacto del CRM de la organización.',
  '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
  'write', 'derived', 'crm.write', 15, true);

INSERT INTO public.organization_tool_grants
  (organization_id, tool_key, trust_state, granted_by, revoked_at, revoked_by)
VALUES
  ('aaaaaaaa-f100-0000-0000-000000000001', 'calendar.find_availability', 'autonomous',
   '11111111-f100-0000-0000-000000000001', NULL, NULL),
  ('aaaaaaaa-f100-0000-0000-000000000001', 'calendar.create_event', 'draft_review',
   '11111111-f100-0000-0000-000000000001', NULL, NULL),
  ('aaaaaaaa-f100-0000-0000-000000000001', 'crm.link_activity', 'supervised',
   '11111111-f100-0000-0000-000000000001', pg_catalog.now(),
   '11111111-f100-0000-0000-000000000001');

-- --- S: shape --------------------------------------------------------------

SELECT has_table('public', 'tool_definitions', 'S1: public.tool_definitions exists');

SELECT has_table('public', 'organization_tool_grants',
  'S2: public.organization_tool_grants exists');

SELECT col_is_pk('public', 'organization_tool_grants',
  ARRAY['organization_id', 'tool_key'],
  'S3: the grant key is (organization_id, tool_key) — the composite target a future agent-scoped child can foreign-key to');

SELECT throws_ok(
  $$INSERT INTO public.tool_definitions
      (key, version, display_name, description, input_schema, output_schema,
       permission_class, idempotency_mode, required_capability, max_runtime_seconds)
    VALUES ('calendar.destroy_everything', 1, 'x', 'a dangerous tool',
       '{}'::jsonb, '{}'::jsonb, 'everything', 'none', 'calendar.write', 10)$$,
  '23514', NULL,
  'S4: a permission_class outside the four risk classes is refused');

SELECT throws_ok(
  $$INSERT INTO public.tool_definitions
      (key, version, display_name, description, input_schema, output_schema,
       permission_class, idempotency_mode, required_capability, max_runtime_seconds)
    VALUES ('Calendar Find Availability', 1, 'x', 'a malformed tool key',
       '{}'::jsonb, '{}'::jsonb, 'read', 'derived', 'calendar.read', 10)$$,
  '23514', NULL,
  'S5: a key that is not dotted-lowercase is refused — grants and manifests refer to this string');

SELECT throws_ok(
  $$INSERT INTO public.tool_definitions
      (key, version, display_name, description, input_schema, output_schema,
       permission_class, idempotency_mode, required_capability, max_runtime_seconds)
    VALUES ('calendar.bad_schema', 1, 'x', 'a tool with a non-object schema',
       '[]'::jsonb, '{}'::jsonb, 'read', 'derived', 'calendar.read', 10)$$,
  '23514', NULL,
  'S6: a schema that is not a JSON object is refused');

-- --- R: registration -------------------------------------------------------

SELECT is(
  (SELECT is_available FROM public.tool_definitions WHERE key = 'calendar.create_event'),
  false,
  'R1: registration without an explicit availability decision ships DISABLED — fail closed');

SELECT throws_ok(
  $$SELECT public.register_tool_definition(
      'crm.link_activity', 1, 'Vincular actividad',
      'Registra una actividad en el contacto del CRM de la organización.',
      '{"type":"object"}'::jsonb, '{"type":"object"}'::jsonb,
      'write', 'derived', 'crm.write', 15, true)$$,
  'P4T04', NULL,
  'R2: a version downgrade is refused — a stale deploy cannot rewind a schema');

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.register_tool_definition(text,integer,text,text,jsonb,jsonb,text,text,text,integer,boolean)',
    'EXECUTE'),
  'R3: authenticated cannot register a tool definition');

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.register_tool_definition(text,integer,text,text,jsonb,jsonb,text,text,text,integer,boolean)',
    'EXECUTE'),
  'R4: service_role can register a tool definition');

-- --- D: discovery privileges ----------------------------------------------

SELECT ok(
  NOT has_function_privilege('anon', 'public.list_available_tools(uuid)', 'EXECUTE'),
  'D1: anon cannot call discovery at all');

SELECT ok(
  has_function_privilege('authenticated', 'public.list_available_tools(uuid)', 'EXECUTE'),
  'D2: authenticated can call discovery — the membership check inside is the gate');

-- --- G: table grants -------------------------------------------------------

SELECT table_privs_are('public', 'tool_definitions', 'authenticated', ARRAY[]::text[],
  'G1: authenticated holds nothing on the catalogue — discovery is the only path');

SELECT table_privs_are('public', 'tool_definitions', 'anon', ARRAY[]::text[],
  'G2: anon holds nothing on the catalogue');

SELECT table_privs_are('public', 'organization_tool_grants', 'authenticated', ARRAY['SELECT'],
  'G3: authenticated may read its own grants and nothing more');

SELECT table_privs_are('public', 'organization_tool_grants', 'anon', ARRAY[]::text[],
  'G4: anon holds nothing on grants');

-- --- L: RLS -----------------------------------------------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.tool_definitions'::regclass),
  'L1: RLS is enabled on tool_definitions');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.tool_definitions'::regclass),
  'L2: and forced, so the owner is not exempt');

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class
    WHERE oid = 'public.organization_tool_grants'::regclass),
  'L3: RLS is enabled on organization_tool_grants');

SELECT ok(
  (SELECT relforcerowsecurity FROM pg_catalog.pg_class
    WHERE oid = 'public.organization_tool_grants'::regclass),
  'L4: and forced');

-- --- M: membership ---------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-f100-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.list_available_tools('aaaaaaaa-f100-0000-0000-000000000001')),
  1,
  'M1: a member sees exactly the one available, non-revoked, granted tool');

SELECT is(
  (SELECT string_agg(tool_key, ',' ORDER BY tool_key)
     FROM public.list_available_tools('aaaaaaaa-f100-0000-0000-000000000001')),
  'calendar.find_availability',
  'M2: and it is the expected one — an unavailable tool is hidden even though it is granted, and a revoked grant is hidden even though the tool is live');

SELECT is(
  (SELECT count(*)::int FROM public.organization_tool_grants
    WHERE organization_id <> 'aaaaaaaa-f100-0000-0000-000000000001'),
  0,
  'M3: RLS shows no other organization''s grants');

SELECT throws_ok(
  $$UPDATE public.organization_tool_grants SET trust_state = 'autonomous'$$,
  '42501', NULL,
  'M4: a member cannot grant themselves autonomy');

SELECT throws_ok(
  $$INSERT INTO public.tool_definitions
      (key, version, display_name, description, input_schema, output_schema,
       permission_class, idempotency_mode, required_capability, max_runtime_seconds)
    VALUES ('calendar.self_granted', 1, 'x', 'a tool invented by a customer',
       '{}'::jsonb, '{}'::jsonb, 'read', 'derived', 'calendar.read', 10)$$,
  '42501', NULL,
  'M5: a member cannot add to the platform catalogue');

RESET ROLE;

-- --- X: cross-organization denial -----------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"11111111-f100-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT * FROM public.list_available_tools('aaaaaaaa-f100-0000-0000-000000000001')$$,
  'P4T01', NULL,
  'X1: a member of another organization gets P4T01 — the same answer a nonexistent organization gets, so ids cannot be probed');

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT * FROM public.list_available_tools('aaaaaaaa-f100-0000-0000-000000000001')$$,
  '42501', NULL,
  'X2: anon cannot even call it');

RESET ROLE;

-- --- K: constraints and definer discipline --------------------------------

SELECT is(
  (SELECT confdeltype FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.organization_tool_grants'::regclass
      AND conname = 'organization_tool_grants_tool_key_fkey'),
  'r'::"char",
  'K1: a granted tool cannot be deleted — ON DELETE RESTRICT, so retiring a tool is is_available = false, not a removal');

SELECT ok(
  (SELECT p.prosecdef AND 'search_path=pg_catalog, public, private, pg_temp' = ANY(p.proconfig)
     FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'list_available_tools'),
  'K2: discovery is SECURITY DEFINER with a fixed search_path');

SELECT ok(
  (SELECT p.prosecdef AND 'search_path=pg_catalog, public, private, pg_temp' = ANY(p.proconfig)
     FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'register_tool_definition'),
  'K3: registration is SECURITY DEFINER with a fixed search_path');

SELECT finish();
ROLLBACK;
