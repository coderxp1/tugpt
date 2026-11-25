-- mcp_org_policy_gate.test.sql
-- Plan A3 (Dev 2): allow_external_tools is the operative per-org lever
-- (20261125000002). With no policy row (or the lever off): the capability list
-- reports disabled_by_policy, list_active_mcp_tools is empty, and
-- resolve_mcp_execution refuses. Owner flips it on via
-- set_external_tools_policy: all three paths open. Member cannot flip it.
BEGIN;
SELECT plan(11);

INSERT INTO auth.users (id, email) VALUES
  ('d3000000-0000-4000-8000-0000000000a1', 'd3-owner@example.test'),
  ('d3000000-0000-4000-8000-0000000000a2', 'd3-member@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('d3000000-0000-4000-8000-0000000000a1', 'd3-owner@example.test'),
  ('d3000000-0000-4000-8000-0000000000a2', 'd3-member@example.test')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('d3000000-0000-4000-8000-00000000000a', 'D3 Org', 'd3-org');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('d3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a1', 'owner'),
  ('d3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000000a2', 'member')
ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status, auth_connection_id) VALUES
  ('d3000000-0000-4000-8000-0000000e0001', 'd3000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/plain', 'D3 plain', 'active', NULL);
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256, approved_by, approved_at) VALUES
  ('d3000000-0000-4000-8000-00000005e001', 'd3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000e0001', 1, repeat('a', 64), 'd3000000-0000-4000-8000-0000000000a1', now());
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
  ('d3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-00000005e001', 'search_docs', 'D3', '{"type":"object"}', 'read');

-- ---- lever OFF (no policy row at all: fail closed) --------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is((SELECT state FROM public.list_chat_capabilities('d3000000-0000-4000-8000-00000000000a')
           WHERE capability_key = 'external.search_docs'),
  'disabled_by_policy', 'A1: capability reports disabled_by_policy with no policy row');
SELECT is(public.list_active_mcp_tools('d3000000-0000-4000-8000-00000000000a'),
  '[]'::jsonb, 'A2: no tools are offered with the lever off');
RESET ROLE;

SET LOCAL ROLE sso_control;
SELECT is(public.resolve_mcp_execution('d3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000e0001'),
  NULL, 'A3: execution resolution refuses with the lever off');
RESET ROLE;

-- ---- member cannot flip the lever -------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok(
  $$SELECT public.set_external_tools_policy('d3000000-0000-4000-8000-00000000000a', true)$$,
  '42501', 'FORBIDDEN', 'B1: a plain member cannot enable external tools');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.organization_integration_policies
                      WHERE organization_id = 'd3000000-0000-4000-8000-00000000000a' AND allow_external_tools),
  'B2: the refused write left no enabling row');

-- ---- owner turns it ON -------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT ok(public.set_external_tools_policy('d3000000-0000-4000-8000-00000000000a', true),
  'C1: owner enables the lever');
SELECT is((SELECT state FROM public.list_chat_capabilities('d3000000-0000-4000-8000-00000000000a')
           WHERE capability_key = 'external.search_docs'),
  'connected', 'C2: capability reports connected with the lever on');
SELECT ok(jsonb_array_length(public.list_active_mcp_tools('d3000000-0000-4000-8000-00000000000a')) = 1,
  'C3: the tool is offered with the lever on');
RESET ROLE;

SET LOCAL ROLE sso_control;
SELECT ok(public.resolve_mcp_execution('d3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000e0001') IS NOT NULL,
  'C4: execution resolves with the lever on');
RESET ROLE;

-- ---- owner turns it back OFF: effect is immediate ----------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT ok(NOT public.set_external_tools_policy('d3000000-0000-4000-8000-00000000000a', false),
  'D1: owner disables the lever');
RESET ROLE;
SET LOCAL ROLE sso_control;
SELECT is(public.resolve_mcp_execution('d3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-0000000e0001'),
  NULL, 'D2: execution refuses again immediately after disabling');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
