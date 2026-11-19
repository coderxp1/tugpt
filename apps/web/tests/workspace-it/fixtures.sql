-- Fixtures for src/lib/workspace-data/workspace-api.integration.test.ts.
-- Disposable database ONLY (never the shared preview DB). Idempotent: deleting
-- the two organizations cascades everything the previous run created.
BEGIN;
-- organizations soft-delete and audit_logs are immutable (both by trigger).
-- Disable their user triggers inside this transaction only, so the cascade
-- really removes the previous run. DISPOSABLE DATABASES ONLY.
ALTER TABLE public.organizations DISABLE TRIGGER USER;
ALTER TABLE public.audit_logs DISABLE TRIGGER USER;
DELETE FROM public.organizations WHERE id IN ('a4a00000-0000-4000-8000-00000000000a','a4b00000-0000-4000-8000-00000000000b');
ALTER TABLE public.organizations ENABLE TRIGGER USER;
ALTER TABLE public.audit_logs ENABLE TRIGGER USER;
DELETE FROM auth.users WHERE id IN ('a4111111-1111-4111-8111-111111111111','a4222222-2222-4222-8222-222222222222',
  'a4333333-3333-4333-8333-333333333333','a4444444-4444-4444-8444-444444444444');
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','a4111111-1111-4111-8111-111111111111','authenticated','authenticated','it_owner_a@example.com','',now(),now(),now(),'{}','{"full_name":"Olivia Owner"}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','a4222222-2222-4222-8222-222222222222','authenticated','authenticated','it_member_a@example.com','',now(),now(),now(),'{}','{"full_name":"Max Member"}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','a4444444-4444-4444-8444-444444444444','authenticated','authenticated','it_viewer_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','a4333333-3333-4333-8333-333333333333','authenticated','authenticated','it_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('a4a00000-0000-4000-8000-00000000000a','IT Org A','it-org-a'), ('a4b00000-0000-4000-8000-00000000000b','IT Org B','it-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('a4a00000-0000-4000-8000-00000000000a','a4111111-1111-4111-8111-111111111111','owner'),
 ('a4a00000-0000-4000-8000-00000000000a','a4222222-2222-4222-8222-222222222222','agent'),
 ('a4a00000-0000-4000-8000-00000000000a','a4444444-4444-4444-8444-444444444444','viewer'),
 ('a4b00000-0000-4000-8000-00000000000b','a4333333-3333-4333-8333-333333333333','owner');
INSERT INTO public.chat_threads (id, organization_id, owner_user_id, title, model_key) VALUES
 ('a4700000-0000-4000-8000-0000000000a2','a4a00000-0000-4000-8000-00000000000a','a4222222-2222-4222-8222-222222222222','Quarterly budget','tugpt-scout'),
 ('a4700000-0000-4000-8000-0000000000a3','a4a00000-0000-4000-8000-00000000000a','a4222222-2222-4222-8222-222222222222','Team offsite','tugpt-scout'),
 ('a4700000-0000-4000-8000-0000000000a1','a4a00000-0000-4000-8000-00000000000a','a4111111-1111-4111-8111-111111111111','Owner notes','tugpt-scout'),
 ('a4700000-0000-4000-8000-0000000000b1','a4b00000-0000-4000-8000-00000000000b','a4333333-3333-4333-8333-333333333333','B thread','tugpt-scout');
INSERT INTO public.chat_messages (thread_id, organization_id, role, content) VALUES
 ('a4700000-0000-4000-8000-0000000000a3','a4a00000-0000-4000-8000-00000000000a','user','Please draft the invoice reconciliation summary');
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
 ('a4e00000-0000-4000-8000-00000000000a','a4a00000-0000-4000-8000-00000000000a','mcp','https://mcp.example.com/a','Billing MCP','active'),
 ('a4e00000-0000-4000-8000-00000000000b','a4b00000-0000-4000-8000-00000000000b','mcp','https://mcp.example.com/b','B MCP','active');
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256) VALUES
 ('a4500000-0000-4000-8000-00000000000a','a4a00000-0000-4000-8000-00000000000a','a4e00000-0000-4000-8000-00000000000a',1,repeat('a',64)),
 ('a4500000-0000-4000-8000-00000000000b','a4b00000-0000-4000-8000-00000000000b','a4e00000-0000-4000-8000-00000000000b',1,repeat('b',64));
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
 ('a4a00000-0000-4000-8000-00000000000a','a4500000-0000-4000-8000-00000000000a','send_invoice','Send an invoice','{}','write'),
 ('a4a00000-0000-4000-8000-00000000000a','a4500000-0000-4000-8000-00000000000a','list_invoices','List invoices','{}','read'),
 ('a4b00000-0000-4000-8000-00000000000b','a4500000-0000-4000-8000-00000000000b','send_invoice','Send an invoice','{}','write');
UPDATE public.external_tool_snapshots SET approved_by='a4111111-1111-4111-8111-111111111111', approved_at=now() WHERE id='a4500000-0000-4000-8000-00000000000a';
UPDATE public.external_tool_snapshots SET approved_by='a4333333-3333-4333-8333-333333333333', approved_at=now() WHERE id='a4500000-0000-4000-8000-00000000000b';
-- Rate-limit windows are per user; repeated runs within an hour must not hit file.upload etc.
DELETE FROM private.workspace_rate_limits WHERE bucket LIKE '%:a4a00000-0000-4000-8000-00000000000a:%' OR bucket LIKE '%:a4b00000-0000-4000-8000-00000000000b:%';
COMMIT;
