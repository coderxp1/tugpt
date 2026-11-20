-- 20261120000001_connect_mcp_privilege_hygiene.sql
--
-- Forward-only correction for 20261115000005_tool_approvals.sql and
-- 20261115000006_mcp_audit.sql. Those migrations created public.tool_approvals
-- and public.mcp_tool_calls without revoking Supabase's default privileges, so
-- anon and authenticated held ALL (arwdDxt) on both tables.
--
-- Impact measured on a real Postgres 15 (supabase/postgres:15.8.1.085) built
-- from every migration up to 20261115000022:
--   SET ROLE authenticated; TRUNCATE public.tool_approvals, public.mcp_tool_calls;
--   -> succeeds. TRUNCATE is not subject to row-level security, so any signed-in
--   user (and anon) could erase every tenant's approvals and MCP audit trail.
--
-- End state (least privilege):
--   anon           : nothing
--   authenticated  : SELECT only (row visibility still governed by the
--                    existing org-member RLS policies *_read)
--   service_role   : SELECT only. All writes go through the SECURITY DEFINER
--                    RPCs owned by postgres (record_tool_approval,
--                    claim_tool_approval, revoke_tool_approval,
--                    is_tool_approved, record_mcp_tool_call), which do not need
--                    caller table privileges. This makes approval and audit
--                    rows unforgeable and undeletable from any API role.
--   PUBLIC         : nothing
--
-- FORCE ROW LEVEL SECURITY is intentionally NOT added here: after this
-- migration no non-owner role can write, and forcing RLS on the owner would
-- change behaviour of the SECURITY DEFINER RPCs on hosts where postgres lacks
-- BYPASSRLS. That is tracked separately rather than mixed into a grant fix.
--
-- Function EXECUTE grants are unchanged (verified: no anon/PUBLIC EXECUTE).

REVOKE ALL ON TABLE public.tool_approvals FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mcp_tool_calls FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.tool_approvals TO authenticated, service_role;
GRANT SELECT ON TABLE public.mcp_tool_calls TO authenticated, service_role;

-- Self-verification: abort the migration if any API role still holds more
-- than SELECT, or if the read path was removed.
DO $verify$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ')
    INTO bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('tool_approvals', 'mcp_tool_calls')
     AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role', 'sso_control')
     AND privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'privilege hygiene not achieved: %', bad;
  END IF;

  IF (SELECT count(*) FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND table_name IN ('tool_approvals', 'mcp_tool_calls')
         AND grantee = 'authenticated' AND privilege_type = 'SELECT') <> 2 THEN
    RAISE EXCEPTION 'authenticated SELECT read path missing after hygiene migration';
  END IF;

  IF has_table_privilege('anon', 'public.tool_approvals', 'SELECT')
     OR has_table_privilege('anon', 'public.mcp_tool_calls', 'SELECT') THEN
    RAISE EXCEPTION 'anon still has SELECT on approval/audit tables';
  END IF;
END
$verify$;
