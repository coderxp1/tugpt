# Frontend integration handover (backend â†’ Agent 1)

All contracts below are read from the actual implementation in `tugpt-workspace-v1`
(branch `feat/workspace-v1`). Backend items B-1 through B-7 are implemented.

## 1. Google OAuth
- **Start:** `GET /api/v1/connect/google/start` (owner/admin) â†’ `302` to Google consent.
  On any failure the browser is redirected to `/settings/integrations?google=error&reason=â€¦`
  (B-6); reasons: `forbidden | not_configured`.
- **Callback:** `GET /api/v1/connect/oauth/callback/google?code=â€¦&state=â€¦` â†’
  `302` to `/settings/integrations?google=connected`, or `?google=error&reason=â€¦`.

## 2. Microsoft 365 OAuth
- **Start:** `GET /api/v1/connect/microsoft/start` â†’ `302` to Microsoft consent; failures redirect
  to `/settings/integrations?microsoft=error&reason=â€¦`.
- **Callback:** `GET /api/v1/connect/oauth/callback/microsoft?code=â€¦&state=â€¦` â†’
  `302` to `/settings/integrations?microsoft=connected|error&reason=â€¦`.
- **Scope:** `Calendars.ReadBasic offline_access` (seeded short form; see migration 20261115000003).

## 3. Disconnect (B-5)
- `POST /api/v1/connect/google/disconnect` and `POST /api/v1/connect/microsoft/disconnect`
  (owner/admin). Revokes the credential through the broker (`POST /v1/revoke`) and marks the
  `connected_accounts` row `revoked` (the runtime then refuses it).
- Success â†’ `302` `/settings/integrations?{provider}=revoked`; failure â†’
  `?{provider}=error&reason=disconnect_failed`.

## 4. Connection status
- `GET /api/v1/chat/capabilities` â†’ `{ capabilities: [{ capabilityKey, providerKey, providerName,
  description, permissionClass, state, toolAvailable }] }`. `connectionId` is not exposed.
- `state` âˆˆ `connected | requires_connection | disabled_by_policy | not_available`.
- Approved, active customer-MCP tools now appear here (B-4): `capabilityKey = 'external.<name>'`,
  `providerKey = 'mcp'`, `state = 'connected'`.

## 5. Calendar tools (Google + Microsoft)
Both share `capability='calendar.find_availability'`, `modelName='calendar_find_availability'`,
`risk='read'`; `provider` is `google` / `microsoft`.
- Input: `{ start, end, durationMinutes (5â€“480), timeZone?, limit? }` (ISO-8601).
- Output: `{ timeZone, fetchedAt, slots: [{ start, end }] }`.
- Register both via `createBuiltInCalendarTools()` from `@tugpt/connect-runtime` (B-3).

## 6. Customer MCP (B-1, B-2 + prior)
All owner/admin, every query scoped by `organization_id`.

| Action | Method + path | Body â†’ response |
|---|---|---|
| List servers (B-1) | `GET /api/v1/connect/mcp/endpoints` | â†’ `{ endpoints: [{ id, url, displayName, status }] }` |
| Register | `POST /api/v1/connect/mcp/endpoints` | `{ url, displayName }` â†’ `201 { endpoint }` |
| Snapshot/discover | `POST /api/v1/connect/mcp/endpoints/{id}/snapshot` | â†’ `201 { snapshotId, toolCount }` |
| Read tools (B-2) | `GET /api/v1/connect/mcp/snapshots/{snapshotId}/tools` | â†’ `{ tools: [{ name, description, inputSchema, permissionClass }] }` |
| Approve + permissions | `POST /api/v1/connect/mcp/snapshots/{id}/approve` | `{ permissions: {"<name>": "read"\|"write"\|"irreversible"\|"financial"} }` â†’ `{ snapshotId, permissionCount }` |
| Activate | `POST /api/v1/connect/mcp/endpoints/{id}/activate` | â†’ `{ status:"active" }` or `409 ACTIVATION_DENIED` (role + approved snapshot + egress verified) |
| Deactivate | `POST /api/v1/connect/mcp/endpoints/{id}/deactivate` | â†’ `{ status:"disabled" }` |
| Delete | `DELETE /api/v1/connect/mcp/endpoints/{id}` | â†’ `{ deleted:true }` (cascades to snapshots/tools) |

Approved tools become executable via `createExternalMcpTool(endpoint, toolDef)`; discovery via
`listExternalMcpTools(endpoint)`.

## 7. Chat integration + approval (B-7)
- Extend `registeredTools()` with `createBuiltInCalendarTools()` and, per approved endpoint,
  `createExternalMcpTool(...)`.
- `buildChatToolset` builds a `ConnectToolRuntime` enforcing: policy â†’ grants â†’ **approval** â†’
  broker token â†’ execute â†’ audit (all fail-closed).
- **Approval lifecycle (per-invocation, atomic, role-gated):**
  1. A non-read (`risk='write'`) tool call is proposed â†’ the runtime returns `APPROVAL_REQUIRED`
     (with the tool + arguments). It is **not executed**.
  2. An **owner/admin** records an approval for that **specific operation** via
     `record_tool_approval(org, connection, capability, argumentsSha256, ttlSeconds)`
     (TTL validated 1..3600 s; plain INSERT â€” each approval is a new explicit action, never an upsert).
  3. The runtime's `ApprovalChecker.claimApproval(...)` hook atomically **claims** the approval via
     `claim_tool_approval(org, connection, capability, argumentsSha256)` â€” a single
     `UPDATE â€¦ FOR UPDATE SKIP LOCKED` that marks it used exactly once and returns true for one
     caller only (unexpired, unused, unreved, exact argument match). Concurrent, expired, replayed
     or different-argument attempts return false.
  4. `is_tool_approved(org, connection, capability, argumentsSha256)` is a read-only status check
     (for the UI). Membership is enforced in every function; cross-tenant claims/reads return false.
  5. An owner/admin may **revoke** a pending approval via
     `revoke_tool_approval(org, connection, capability, argumentsSha256)` â€” immediate (revoked rows
     are excluded from claim), recorded via `revoked_at`/`revoked_by`. Each `record_tool_approval`
     is a distinct explicit authorization; multiple rows for the same operation are each claimable once.
  6. Approval is recorded (`tool_approvals.approved_by/at`) and execution is audited via
     `record_connect_tool_call` (outcome + argument SHA-256).
- `runTurn` streams NDJSON `user | tool_start | tool_result | delta | done | error`; tool results are
  `{ ok:true, data }` or `{ ok:false, code }`.
- Tool calling stays off until `verifiedToolModels` is populated by a live probe; no broker â†’
  `PROVIDER_UNAVAILABLE`.

## 8. Error states
`NOT_GRANTED, POLICY_DISABLED, SCOPE_MISSING, APPROVAL_REQUIRED, PROVIDER_MISMATCH,
CONNECTION_NOT_FOUND, CONNECTION_NOT_ACTIVE, REAUTHORIZATION_REQUIRED, PROVIDER_UNAVAILABLE,
UNKNOWN_TOOL, INVALID_ARGUMENTS, OUTPUT_TOO_LARGE, CALL_BUDGET_EXCEEDED, INTERNAL`.
