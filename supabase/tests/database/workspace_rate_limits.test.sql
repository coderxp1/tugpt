-- workspace_rate_limits.test.sql — 20261120100003: server-side fixed-window
-- limits per (action, organization, user); membership required; unknown
-- actions rejected; counters private.
BEGIN;
SELECT plan(12);

INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','e9111111-1111-4111-8111-111111111111','authenticated','authenticated','ws_rl_a1@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e9222222-2222-4222-8222-222222222222','authenticated','authenticated','ws_rl_a2@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','e9333333-3333-4333-8333-333333333333','authenticated','authenticated','ws_rl_b1@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES ('e9a00000-0000-4000-8000-00000000000a','RL A','ws-rl-a'), ('e9b00000-0000-4000-8000-00000000000b','RL B','ws-rl-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('e9a00000-0000-4000-8000-00000000000a','e9111111-1111-4111-8111-111111111111','owner'),
 ('e9a00000-0000-4000-8000-00000000000a','e9222222-2222-4222-8222-222222222222','agent'),
 ('e9b00000-0000-4000-8000-00000000000b','e9333333-3333-4333-8333-333333333333','owner');

SELECT ok(NOT has_table_privilege('authenticated','private.workspace_rate_limits','SELECT')
  AND NOT has_table_privilege('authenticated','private.workspace_rate_limit_policies','UPDATE')
  AND NOT has_table_privilege('service_role','private.workspace_rate_limit_policies','UPDATE'), 'counters and policies are not reachable through the API'); -- 1
SELECT ok(NOT has_function_privilege('anon','public.consume_workspace_rate_limit(uuid,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.prune_workspace_rate_limits()','EXECUTE')
  AND has_function_privilege('service_role','public.prune_workspace_rate_limits()','EXECUTE'), 'function grants'); -- 2

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e9111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT is((SELECT array_agg(allowed::text || ':' || remaining) FROM public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a','agent.run')), ARRAY['true:29'], 'first call allowed, 29 left'); -- 3
SELECT is((SELECT count(*)::int FROM generate_series(1,29) g, LATERAL public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a', CASE WHEN g > 0 THEN 'agent.run' END) r WHERE r.allowed), 29, 'calls up to the limit are allowed'); -- 4 (CASE keeps the call per row)
SELECT ok((SELECT NOT allowed AND remaining = 0 AND retry_after_seconds BETWEEN 1 AND 60 FROM public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a','agent.run')), 'call 31 is refused with Retry-After'); -- 5
SELECT ok((SELECT allowed FROM public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a','library.search')), 'actions have separate budgets'); -- 6
SELECT throws_ok($$SELECT * FROM public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a','admin.anything')$$, '22023', 'INVALID_ACTION', 'unknown action rejected'); -- 7
SELECT throws_ok($$SELECT * FROM public.consume_workspace_rate_limit('e9b00000-0000-4000-8000-00000000000b','agent.run')$$, '42501', 'FORBIDDEN', 'non-members cannot consume (or exhaust) another tenant''s budget'); -- 8

SELECT set_config('request.jwt.claims','{"sub":"e9222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
SELECT ok((SELECT allowed AND remaining = 29 FROM public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a','agent.run')), 'budgets are per user'); -- 9

RESET ROLE;
UPDATE private.workspace_rate_limits SET window_start = now() - interval '61 seconds' WHERE bucket = 'agent.run:e9a00000-0000-4000-8000-00000000000a:e9111111-1111-4111-8111-111111111111';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"e9111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
SELECT ok((SELECT allowed AND remaining = 29 FROM public.consume_workspace_rate_limit('e9a00000-0000-4000-8000-00000000000a','agent.run')), 'a new window starts after the old one ends'); -- 10

RESET ROLE;
UPDATE private.workspace_rate_limits SET window_start = now() - interval '3 days' WHERE bucket LIKE '%:e9a00000-0000-4000-8000-00000000000a:e9222222-2222-4222-8222-222222222222';
SET LOCAL ROLE service_role;
SELECT ok(public.prune_workspace_rate_limits() >= 1, 'prune removes expired counters'); -- 11
RESET ROLE;
SELECT is((SELECT count(*)::int FROM private.workspace_rate_limits WHERE bucket LIKE '%:e9a00000-0000-4000-8000-00000000000a:%'), 2, 'live counters are kept'); -- 12

SELECT * FROM finish();
ROLLBACK;
