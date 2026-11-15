# Migration verification procedure (development only â€” NOT applied)

Applies the new Connect migrations to a throwaway dev database. Do not run against production
or any shared database.

## Application order (after the existing baseline)
1. `20261112000001_connect_registry.sql` (baseline, already present)
2. `20261115000001_workspace_chat.sql` (Agent 1)
3. `20261115000002_create_images.sql` (Agent 1)
4. `20261115000003_microsoft_connect_seed.sql` â€” provider seed + scope reconcile
5. `20261115000004_mcp_capabilities.sql` â€” `list_chat_capabilities` UNIONs MCP tools
6. `20261115000005_tool_approvals.sql` â€” approval table + 4 functions
   (`record_tool_approval`, `claim_tool_approval`, `is_tool_approved`, `revoke_tool_approval`)

## Required extensions / permissions
- `pgcrypto` not required (uses `gen_random_uuid()`).
- `private.is_org_member`, `private.has_org_role`, and `auth.uid()` must exist (from the baseline
  migration). The new migrations are `SECURITY DEFINER` with `search_path = pg_catalog`; they run
  as the migration owner (typically `postgres`/service role).

## Verification (in the dev DB)
1. `SELECT * FROM integration_provider_capabilities WHERE provider_key='microsoft';`
   â†’ `required_scopes` must be `{Calendars.ReadBasic}` (not the full URI).
2. `SELECT * FROM list_chat_capabilities('<org-id>');` as an authenticated member of that org
   â†’ includes first-party capabilities AND, for an active+approved MCP endpoint,
   `('external.<tool>', 'mcp', <display_name>, â€¦, 'connected', <endpoint_id>)`.
3. Approval lifecycle (owner/admin for record/revoke; membership for claim/read):
   - As a non-owner member, `record_tool_approval(...)` and `revoke_tool_approval(...)` raise `42501`.
   - As owner/admin, `record_tool_approval('<org>','<conn>','external.x','<64-hex>', 60)` inserts.
   - `is_tool_approved(...)` â†’ `true` (read-only).
   - `claim_tool_approval(...)` â†’ `true` once, then `false` (atomic single-use).
   - `revoke_tool_approval('<org>','<conn>','external.x','<64-hex>')` â†’ `true`; the approval is then
     unclaimable (`claim_tool_approval` â†’ `false`); `revoked_at`/`revoked_by` record the revocation.
   - A different argument hash â†’ `false`; a `0`/`9999` TTL â†’ `22023`.
   - Multiple `record_tool_approval` calls for the same operation create DISTINCT rows â€” each is an
     independent explicit authorization, claimable exactly once (`claim` takes the earliest unused row by `ORDER BY approved_at ASC, id ASC`).
4. Tenant isolation: as a member of org B, `list_chat_capabilities('<org-A-id>')` returns nothing;
   `record_tool_approval`/`revoke_tool_approval` for org A raise `42501`; `claim_tool_approval`/
   `is_tool_approved` for org A return `false`.

## Concurrency verification (two-session)
The atomic claim is proven by `FOR UPDATE SKIP LOCKED`. To verify against a real PostgreSQL,
open two `psql` sessions and run simultaneously:

```sql
-- session 1 and session 2 (same args), after one record_tool_approval(...):
SELECT claim_tool_approval('<org>', '<conn>', 'external.x', '<64-hex>');
```

Exactly one session returns `true`; the other returns `false`. A third call returns `false`
(the approval is consumed). Re-run with a revoked or expired approval â†’ always `false`.

## Rollback / recovery (order matters â€” functions first, then the table)
1. Drop the four approval functions (they reference the table):
   - `DROP FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER);`
   - `DROP FUNCTION public.claim_tool_approval(UUID,UUID,TEXT,TEXT);`
   - `DROP FUNCTION public.is_tool_approved(UUID,UUID,TEXT,TEXT);`
   - `DROP FUNCTION public.revoke_tool_approval(UUID,UUID,TEXT,TEXT);`
2. `DROP TABLE public.tool_approvals;` (removes `revoked_at`/`revoked_by` with it).
3. The approval objects are independent of `list_chat_capabilities`; to also revert B-4:
   `DROP FUNCTION public.list_chat_capabilities(UUID);` then re-apply the original `SECURITY INVOKER`
   definition from `20261115000001_workspace_chat.sql`. No dangling references remain either way.
4. The seed/scope migrations (`â€¦03`) are idempotent (`ON CONFLICT`); re-running them is harmless.

## Execution status
The pgTAP suite (`supabase/tests/tool_approvals.test.sql`) and the two-session concurrency test
above are **prepared but NOT EXECUTED** â€” no live database has been used in this session. Do not
treat database verification or concurrency testing as passed until they have actually run.

## Customer MCP remains disabled
Nothing above enables customer MCP by itself: activation still fails closed (`ACTIVATION_DENIED`)
until the deployed egress proxy passes its DNS-pinning, private-address-blocking and
bypass-prevention tests (`docs/connect/egress-proxy/egress-probe.cjs`).
