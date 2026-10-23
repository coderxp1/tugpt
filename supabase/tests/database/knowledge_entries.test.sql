-- knowledge_entries.test.sql
--
-- Migration 20261022000004: workspace-scoped FAQ entries.
--
-- WHAT THIS FILE IS DEFENDING:
--
--   1. Tenant isolation on a table whose whole purpose is to be fed
--      into a language model. One organization's facts appearing in
--      another's drafts would not just leak data — it would put
--      wrong prices and hours in front of the wrong customers, in
--      the business's own voice (K-group).
--
--   2. Write authority: any member can read the workspace's facts,
--      but only owner/admin can change what the business states as
--      fact (W-group). An agent stuffing the knowledge base is a
--      prompt-injection vector with a login.
--
--   3. The enabled flag, which is how a business retracts a fact
--      without deleting history (E-group).

BEGIN;
SELECT plan(10);

-- --- Fixtures ---------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('b0000000-7f11-0000-0000-000000000001', 'owner-a@faq.test'),
  ('b0000000-7f11-0000-0000-000000000002', 'agent-a@faq.test'),
  ('b0000000-7f11-0000-0000-000000000003', 'owner-b@faq.test');
-- profiles arrive via the handle_new_user trigger.

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7f11-0000-0000-000000000001', 'Clínica A', 'faq-a'),
  ('aaaaaaaa-7f11-0000-0000-000000000002', 'Clínica B', 'faq-b');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-7f11-0000-0000-000000000001', 'b0000000-7f11-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-7f11-0000-0000-000000000001', 'b0000000-7f11-0000-0000-000000000002', 'agent'),
  ('aaaaaaaa-7f11-0000-0000-000000000002', 'b0000000-7f11-0000-0000-000000000003', 'owner');

INSERT INTO public.knowledge_entries (id, organization_id, question, answer, enabled) VALUES
  ('11111111-7f11-0000-0000-000000000001', 'aaaaaaaa-7f11-0000-0000-000000000001',
   '¿Cuál es el horario?', 'Lunes a viernes, 9:00 a 18:00.', true),
  ('11111111-7f11-0000-0000-000000000002', 'aaaaaaaa-7f11-0000-0000-000000000001',
   '¿La consulta tiene costo?', 'La primera consulta es gratuita.', false),
  ('11111111-7f11-0000-0000-000000000003', 'aaaaaaaa-7f11-0000-0000-000000000002',
   '¿Cuál es el horario?', 'Sábados, 10:00 a 14:00.', true);

-- --- K. Tenant isolation on reads ---------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7f11-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::INT FROM public.knowledge_entries),
  2, 'K1: a member of org A sees org A''s entries (both enabled states)');

SELECT is(
  (SELECT count(*)::INT FROM public.knowledge_entries
   WHERE organization_id = 'aaaaaaaa-7f11-0000-0000-000000000002'),
  0, 'K2: org B''s entries are invisible — no row, not even a count');

SET LOCAL ROLE postgres;

-- An outsider (authenticated, member of nothing) sees nothing.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7f11-0000-0000-000000000099","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::INT FROM public.knowledge_entries),
  0, 'K3: a non-member sees no entries at all');
RESET ROLE;

-- --- W. Write authority ----------------------------------------------------------

-- The owner of org A can add an entry for org A.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7f11-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ INSERT INTO public.knowledge_entries (organization_id, question, answer)
     VALUES ('aaaaaaaa-7f11-0000-0000-000000000001', '¿Hacen envíos?', 'Sí, a todo el país.') $$,
  'W1: an owner can add an entry to their own workspace');

-- An agent (member, not owner/admin) cannot write.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7f11-0000-0000-000000000002","role":"authenticated"}', true);

SELECT throws_ok(
  $$ INSERT INTO public.knowledge_entries (organization_id, question, answer)
     VALUES ('aaaaaaaa-7f11-0000-0000-000000000001', '¿Descuentos?', 'Todo al 90% hoy.') $$,
  '42501', NULL,
  'W2: an agent cannot add entries — write authority is owner/admin only');

-- The owner of org A cannot write into org B (WITH CHECK).
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7f11-0000-0000-000000000001","role":"authenticated"}', true);

SELECT throws_ok(
  $$ INSERT INTO public.knowledge_entries (organization_id, question, answer)
     VALUES ('aaaaaaaa-7f11-0000-0000-000000000002', '¿Horario?', 'Nunca cerramos.') $$,
  '42501', NULL,
  'W3: an owner cannot write into another workspace');

-- Nor modify org B's existing entry: RLS filters it out of the
-- UPDATE entirely, so the statement affects zero rows and the
-- entry is provably unchanged afterward.
UPDATE public.knowledge_entries SET answer = 'Texto inyectado.'
WHERE id = '11111111-7f11-0000-0000-000000000003';
RESET ROLE;

SELECT is(
  (SELECT answer FROM public.knowledge_entries
   WHERE id = '11111111-7f11-0000-0000-000000000003'),
  'Sábados, 10:00 a 14:00.',
  'W4: another workspace''s entry is untouched by the update attempt');

-- --- E. The enabled flag and content checks ---------------------------------------

SELECT is(
  (SELECT count(*)::INT FROM public.knowledge_entries
   WHERE organization_id = 'aaaaaaaa-7f11-0000-0000-000000000001' AND enabled),
  2, 'E1: enabled entries are the worker''s candidate set (the disabled one is excluded)');

SELECT throws_ok(
  $$ INSERT INTO public.knowledge_entries (organization_id, question, answer)
     VALUES ('aaaaaaaa-7f11-0000-0000-000000000001', '   ', 'Respuesta.') $$,
  '23514', NULL,
  'E2: a blank question is refused by the content check');

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.knowledge_entries', 'TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.knowledge_entries', 'SELECT'),
  'E3: no destructive grants survive on the new table, and anon cannot read it');

SELECT * FROM finish();
ROLLBACK;
