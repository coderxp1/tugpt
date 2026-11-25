-- platform_capability_bindings.test.sql
-- B6: bindings are service-side only, disabled by default, and cascade with
-- their endpoint.
BEGIN;
SELECT plan(5);

INSERT INTO public.platform_tool_endpoints (id, kind, url, display_name, status) VALUES
  ('da000000-0000-4000-8000-0000000e0001', 'mcp', 'https://mcp.example.test/b6', 'B6', 'active');

SELECT ok(NOT has_table_privilege('authenticated', 'public.platform_capability_bindings', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.platform_capability_bindings', 'SELECT'),
  'A1: org roles have no access to capability bindings');
SELECT ok(has_table_privilege('service_role', 'public.platform_capability_bindings', 'SELECT'),
  'A2: service_role has access');

SET LOCAL ROLE service_role;
INSERT INTO public.platform_capability_bindings (capability_key, endpoint_id, tool_name) VALUES
  ('video.generate', 'da000000-0000-4000-8000-0000000e0001', 'generate_video');
SELECT ok((SELECT enabled = false FROM public.platform_capability_bindings WHERE capability_key = 'video.generate'),
  'B1: a binding is disabled by default');
SELECT throws_ok($$INSERT INTO public.platform_capability_bindings (capability_key, endpoint_id, tool_name) VALUES
  ('video.generate', 'da000000-0000-4000-8000-0000000e0001', 'other_tool')$$,
  '23505', NULL, 'B2: one binding per capability');
RESET ROLE;

DELETE FROM public.platform_tool_endpoints WHERE id = 'da000000-0000-4000-8000-0000000e0001';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.platform_capability_bindings WHERE capability_key = 'video.generate'),
  'B3: deleting the endpoint cascades the binding');

SELECT * FROM finish();
ROLLBACK;
