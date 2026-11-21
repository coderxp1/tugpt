# Security finding: service_role retains DELETE/TRUNCATE on appointment tables

Status: **open, documented only, not fixed by Agent 2** (outside my scope). Owner: appointments / database owners.
Severity: medium (defence in depth; service_role is server-only, but it widens the blast radius of a leaked key or a server bug, and audit-like rows can be erased).

## Affected migration

`supabase/migrations/20261019000001_appointment_requests.sql`

- Lines 347-348: `REVOKE ALL ... FROM anon, authenticated;` (service_role is **not** revoked)
- Lines 374-375: `GRANT SELECT, INSERT, UPDATE ON public.appointment_requests / appointment_suggestions TO service_role;`

`GRANT` is additive. The schema default ACL in `public` (`pg_default_acl` for `postgres` and `supabase_admin`) already grants `service_role` `arwdDxt` on every new table, so the narrow GRANT does not narrow anything.

## Verified (read-only, isolated Agent 2 harness DB)

```
appointment_requests    service_role: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
appointment_suggestions service_role: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
```

`supabase/tests/database/appointment_requests.test.sql` assertion P3 ("service_role holds no DELETE on either table") already fails for this reason. No application code deletes or truncates these rows (grep across `apps/` and `packages/`).

## Recommended forward-only fix (new migration; do not edit the existing one)

```sql
REVOKE ALL ON public.appointment_requests, public.appointment_suggestions FROM service_role;
GRANT SELECT, INSERT, UPDATE ON public.appointment_requests, public.appointment_suggestions TO service_role;
```

Acceptance: P3 passes; `has_table_privilege('service_role', ..., 'DELETE'|'TRUNCATE'|'TRIGGER'|'REFERENCES')` is false for both tables; the app's appointment flows still pass.

## Systemic issue (same root cause)

44 of 63 tables in `public` give `service_role` TRUNCATE. Audit-like tables among them: `ai_draft_review_events`, `audit_logs`, `connect_tool_calls`, `conversation_events`, `provider_usage_events`, `webhook_events` (plus the two appointment tables). The pattern used for `mcp_approval_events` in `20261120000011` (REVOKE ALL, then GRANT the minimum) is the reference.

Recommendations for the table owners:
1. A repo-wide privilege audit as a pgTAP test (expected privileges per table, per role).
2. Forward-only migrations per table group (REVOKE ALL + minimal GRANT), at least for the audit-like tables (append-only: SELECT, INSERT).
3. Consider `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM service_role, anon, authenticated;` so new tables start narrow. This changes behaviour for future migrations and needs owner sign-off.
