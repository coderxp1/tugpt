# Database-backed Connect lookups: implementation and test plan

Status: **design, not implemented.** `@tugpt/connect-runtime` depends only on four interfaces (`ConnectionDirectory`, `IntegrationPolicy`, `GrantChecker`, `ToolAuditSink`). Its 36 unit tests and the 13 separation tests use in-memory fakes. This document fixes how the Postgres implementations will work and how they will be proven.

## 1. Where they live and how they connect

- Package: `apps/worker/src/connect/` (worker-only; the runtime runs in the worker). The runtime package stays free of database code and keeps its dependency allowlist.
- Credentials: the worker's existing server-side Supabase/Postgres access. Every query is parameterized and always includes `organization_id`. The organization comes from the **job's server-resolved context** (ADR-020: the job row's `organization_id`, written by an authenticated API route after `resolveTenantContext`), never from model output or tool arguments.
- No caching in Phase 1. Revocation must take effect on the next call. A short-lived cache, if ever needed, keys on `(organization_id, connection_id)` with a ≤ 5 s TTL and is invalidated on revoke.

## 2. Exact queries

### ConnectionDirectory.getConnection(org, connectionId)
```sql
SELECT id, organization_id, owner_user_id, provider_key, status, scopes
FROM public.connected_accounts
WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL;
```
A row that exists in another organization returns **no row**. The runtime then reports `CONNECTION_NOT_FOUND`, so it can't tell "doesn't exist" from "belongs to someone else".

### IntegrationPolicy.isCapabilityEnabled(org, provider, capability)
```sql
SELECT p.is_available
   AND pc.capability_key IS NOT NULL
   AND (pol.organization_id IS NULL                       -- no row = defaults
        OR pol.allowed_provider_keys IS NULL
        OR p.key = ANY (pol.allowed_provider_keys)) AS enabled
FROM public.integration_providers p
LEFT JOIN public.integration_provider_capabilities pc
       ON pc.provider_key = p.key AND pc.capability_key = $3
LEFT JOIN public.organization_integration_policies pol
       ON pol.organization_id = $1
WHERE p.key = $2;
```
- **Default-off at platform level:** `integration_providers.is_available` defaults to `false`. Google stays unavailable until the staging live test passes, which is the "capability row stays switched off" gate.
- **Per-org opt-out** via `allowed_provider_keys`.
- **Gap, tracked:** there's no per-org, per-capability switch yet (for example "Google allowed, but only read capabilities"). It is added together with the first write capability: a `disabled_capability_keys TEXT[]` column on the policy row, defaulting to `{}`.

### GrantChecker.isGranted({ org, connectionId, capability, actorUserId, agentId })
- **Direct chat** (`agentId = null`):
  - granted if the connection is org-level (`owner_user_id IS NULL`) and the actor is an active member, or if the actor owns the personal connection
  - the runtime has already rejected a personal connection used by someone other than its owner, before this call
  - membership is re-checked in SQL:
```sql
SELECT private.is_org_member($1, $4);
```
- **Agent or workflow** (`agentId` set): an explicit, live grant is required:
```sql
SELECT EXISTS (
  SELECT 1 FROM public.connection_grants g
  WHERE g.organization_id = $1 AND g.connection_id = $2
    AND g.grantee_type = 'agent' AND g.grantee_id = $5 AND g.revoked_at IS NULL
) AND private.is_org_member($1, $4);
```
  Grants are per connection, not per capability, in this migration. Capability scope comes from the registry plus the connection's scopes. If per-capability grants are needed, add `capability_keys TEXT[]` to `connection_grants` (NULL = all read capabilities of the connection).

### ToolAuditSink.record(event)
- **Gap, tracked:** migration `20261112000001` has no tool-call audit table; `credential_access_log` covers broker operations only. A follow-up migration adds `connect_tool_calls`:
  - append-only
  - service-role INSERT only, with `REVOKE UPDATE, DELETE`
  - members with `owner`/`admin` may read their own org's rows
  - columns mirror `ToolAuditEvent`: `at, request_id, organization_id, actor_user_id, agent_id, connection_id, tool_call_id, capability, outcome, duration_ms, arguments_sha256`
  - CHECK constraints: `outcome` must be the runtime's closed code list, and `arguments_sha256 ~ '^[0-9a-f]{64}$'`
  - FK `(connection_id, organization_id)` to `connected_accounts`, so an event can't be filed under the wrong org
- Failure policy: if the audit insert fails, the tool result is still returned, because the external call has already happened and hiding its result from the user doesn't undo it. The failure is logged as `CONNECT_AUDIT_WRITE_FAILED` with an alert, and the event goes to a bounded retry queue on the existing jobs infrastructure. For **write** capabilities (later), the policy flips: the audit row is written *before* execution with outcome `pending`, and the call doesn't run if that insert fails.

## 3. Test plan

| Layer | What | Where |
|---|---|---|
| pgTAP | `connect_tool_calls` append-only, RLS read scoping, FK org pairing, CHECK constraints | `supabase/tests/database/connect_registry.test.sql` (extended) |
| Integration (Vitest + real Postgres) | Each implementation runs against the isolated stack (`tugpt-connect-p0`), seeded with **two organizations, A and B**, plus users: owner A, member A, agent-role A, owner B, and an outsider | `apps/worker/tests/connect-lookups.integration.test.ts` |
| Cross-org cases (must all pass) | B's connection id with org A context gives `null` / `false` / `CONNECTION_NOT_FOUND`; A's grant doesn't authorize B's agent; A's policy row doesn't affect B; an audit event with A's org and B's connection is rejected by the FK; an outsider gets `false` everywhere | same |
| Revocation | revoke a connection or grant, and the next lookup reflects it (no cache) | same |
| Runtime end-to-end | `ConnectToolRuntime` wired to the real implementations plus a fake broker and fake Google, so the full deny ordering runs against real rows | same |
| Mutation checks | remove `organization_id = $1` from each query, and at least one cross-org test must fail; same for `revoked_at IS NULL` | recorded in the PR |

The integration suite runs in CI against a disposable Postgres with the migrations applied, the same way pgTAP runs today. It never runs against production or the shared non-production project.
