-- 20261120000011_mcp_approval_events_service_role_revoke.sql
-- Forward-only fix for 20261120000010_mcp_approval_audit.sql.
--
-- 20261120000010 revoked table privileges on public.mcp_approval_events only
-- from PUBLIC, anon and authenticated. The schema's default privileges had
-- already granted service_role ALL (INSERT, UPDATE, DELETE, TRUNCATE, ...), and
-- service_role bypasses RLS, so a service-role client could forge, delete or
-- truncate audit events (UPDATE was blocked by the append-only trigger only).
--
-- All audit writes go through SECURITY DEFINER functions and triggers owned by
-- the migration owner, so removing the direct grants changes no write path.
-- service_role keeps SELECT, matching public.tool_approvals.

REVOKE ALL ON public.mcp_approval_events FROM service_role;
GRANT SELECT ON public.mcp_approval_events TO service_role;
