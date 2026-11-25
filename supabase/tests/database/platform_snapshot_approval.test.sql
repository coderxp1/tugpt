-- platform_snapshot_approval.test.sql
-- B3: an operator approval (approved_at set, approved_by NULL) is valid on
-- platform snapshots, and immutability still keys off approved_at.
BEGIN;
SELECT plan(3);

INSERT INTO public.platform_tool_endpoints (id, kind, url, display_name, status) VALUES
  ('d8000000-0000-4000-8000-0000000e0001', 'mcp', 'https://mcp.example.test/b3', 'B3', 'pending');
INSERT INTO public.platform_tool_snapshots (id, endpoint_id, version, content_sha256) VALUES
  ('d8000000-0000-4000-8000-00000005e001', 'd8000000-0000-4000-8000-0000000e0001', 1, repeat('a', 64));
INSERT INTO public.platform_tools (snapshot_id, name, description, input_schema) VALUES
  ('d8000000-0000-4000-8000-00000005e001', 'gen', 'g', '{"type":"object"}');

UPDATE public.platform_tool_snapshots SET approved_at = now()
WHERE id = 'd8000000-0000-4000-8000-00000005e001';
SELECT ok((SELECT approved_at IS NOT NULL AND approved_by IS NULL FROM public.platform_tool_snapshots WHERE id = 'd8000000-0000-4000-8000-00000005e001'),
  'A1: operator approval (approved_at only) is accepted');
SELECT throws_ok($$UPDATE public.platform_tools SET permission_class = 'read'
  WHERE snapshot_id = 'd8000000-0000-4000-8000-00000005e001'$$,
  'P4C02', 'CONNECT_SNAPSHOT_IMMUTABLE', 'A2: classification is frozen once approved');
SELECT ok((SELECT status = 'pending' FROM public.platform_tool_endpoints WHERE id = 'd8000000-0000-4000-8000-0000000e0001'),
  'A3: approval alone does not activate the endpoint');

SELECT * FROM finish();
ROLLBACK;
