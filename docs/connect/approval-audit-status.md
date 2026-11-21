# MCP approval audit: milestone status

Status: **backend complete; not fully integrated.** Branch `agent2/mcp-approval-audit` (local, not pushed).

## Done and verified (backend)

| Area | Evidence |
|---|---|
| Migrations (forward-only) | `20261120000010` (audit events), `20261120000011_mcp_approval_events_service_role_revoke.sql` (service_role SELECT only). Applied only to the isolated Agent 2 harness DB. |
| RED/GREEN | 1f94f4f/03eff19, de44018/8ffc018, fa897c4/1b90393 |
| pgTAP | approval audit 48/48 |
| Monorepo gates at 702d2cb | typecheck, lint, test, build: EXIT=0, 55/55 tasks |
| Live harness demo | 17 real audit rows. Org A: approval_requested, approved, claimed, executed, rejected_by_user, replayed, invalid_arguments, NO_APPROVAL, expired, revoked. Org B: 2x THREAD_NOT_ACCESSIBLE. RLS: owner A sees 15, owner B sees 2. |

## Two different "reject" paths: do not confuse them

1. **Server-side reject (implemented, verified):** `POST /api/v1/chat/threads/{threadId}/rejected-call` writes `rejected_by_user`, revokes matching open approvals, and makes a later approve/claim fail (`CALL_REJECTED` / `CLAIM_AFTER_REJECT`). The live demo drives this route directly.
2. **UI Reject button (client-only today):** `apps/web/src/components/chat/ApprovalCard.tsx` line 171 calls only `dispatch({ type: 'reject' })`. **No request reaches the server, so no audit row is written** when a user clicks Reject in the UI. The "Dismiss" button (line 180) is also client-only.

## Frontend contract (owned by Agents 1/3; Agent 2 does not implement the UI)

`POST /api/v1/chat/threads/{threadId}/rejected-call`, same origin, session cookie.

Request body (JSON, exactly these keys):

| Field | Type | Rule |
|---|---|---|
| `connectionId` | string | UUID of the MCP connection on the card |
| `capability` | string | capability name on the card (server regex `CAPABILITY`) |
| `argumentsSha256` | string | lowercase hex SHA-256 of the canonical arguments; the same value the card already uses for request/check approval |

Responses:

| Status | Body | Meaning / UI action |
|---|---|---|
| 200 | `{ "rejected": true, "revokedApprovals": <int> }` | Show "Rejected. Nothing was run." |
| 400 | `{ "error": "Invalid request" }` | Bug in the client payload; keep the card open, show a generic error |
| 403 | `Invalid origin` or `Access denied` | Not permitted; show an error, do not mark rejected |
| 404 | `Not found` | Thread not accessible (also audited as THREAD_NOT_ACCESSIBLE) |
| 503 | `Service unavailable` | Retry is allowed; do not mark rejected locally |

Header: `Cache-Control: private, no-store`. After a 200, a later approve for the same (connection, capability, argumentsSha256) returns **409 CALL_REJECTED**. Details and states: `docs/connect/approval-reject-ui-spec.md`.

## Outstanding before the milestone counts as integrated

- [ ] **UI Reject wired to the route** (Agents 1/3), with a unit test asserting the POST body and that the local state changes only after a 200.
- [ ] **Independent UI verification:** browser click on Reject → a `rejected_by_user` row for that org → a later approve returns 409. Screenshot of the rejected card (the earlier screenshot 09 does not show it and is not evidence).
- [ ] **Non-admin member live test:** all live runs so far used org owners. A `member` session must be run live for request, approve-denied-or-allowed per policy, reject, and RLS visibility. **Not done.**
- [ ] Push/merge/deploy: not authorized; not done.
