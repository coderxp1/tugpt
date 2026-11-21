# UI spec: server-side Reject on the MCP approval card (for Agents 1/3)

Status: backend done by Agent 2 (`agent2/mcp-approval-audit`). Frontend not
changed by Agent 2; this is the contract to implement.

## Problem

`ApprovalCard.tsx` Reject only dispatches `{ type: 'reject' }` to the local
reducer in `lib/chat/approval.ts`. Nothing reaches the server: the decision is
not audited, and an approval already recorded in another tab stays claimable.

## Contract

`POST /api/v1/chat/threads/{threadId}/rejected-call`

- Headers: same as the approved-call request (same origin, `x-tugpt-csrf: 1`,
  `content-type: application/json`).
- Body (exactly these keys): `{ "connectionId": uuid, "capability": "external.<tool>", "argumentsSha256": "<64 hex>" }`,
  taken from the pending approval the server sent (`endpointId`, `capability`,
  `argumentsSha256`). Never send the arguments.

| Status | Body | Meaning / UI |
|---|---|---|
| 200 | `{ "rejected": true, "revokedApprovals": n }` | Rejected on the server. Show "Rejected. Nothing was run." |
| 400 | `{ error }` | Malformed request (bug). Keep the card pending, show a generic error. |
| 403 | `{ error }` | Origin or permission refused. Keep pending, "You cannot reject this action." |
| 404 | `{ error }` | Thread not accessible. Keep pending, generic error. |
| 503 | `{ error }` | Try again. Keep pending, offer Retry. |

## Reducer and card changes

1. Add a `rejecting` state: `pending|failed --reject--> rejecting --rejected--> rejected`,
   `rejecting --reject_failed--> failed` (with reason). Buttons disabled while
   `rejecting`; Reject shows a busy label; `aria-live="polite"` announces the result.
2. Only enter `rejected` after a 200. Do not mark rejected optimistically.
3. If the user approves in another tab after rejecting: the approval route now
   answers **409 `CALL_REJECTED`**. Map it to: "This action was rejected. Ask
   again to request a new approval." and keep the card in `rejected`.
4. Keep the existing revoke flow (`then: 'rejected'`) for an approval this card
   recorded itself; then call the reject route as well, so the event is
   recorded as a user rejection.
5. i18n keys: `chat.approval.rejecting`, `chat.approval.rejectFailed`,
   `chat.approval.callRejected` (existing `chat.approval.rejected` unchanged).

## Acceptance

- Reject sends exactly one POST with the three fields; no arguments in the body.
- 200 shows the rejected state; any other status keeps the card actionable.
- After Reject, Approve in another tab shows the `CALL_REJECTED` message and nothing runs.
- Keyboard: Reject reachable and operable; focus stays on the card; status announced.
