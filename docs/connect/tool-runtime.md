# Connect tool runtime and the Google Calendar read-only slice

Status: **implemented and tested offline (stubbed Google, real in-process credential broker). Not wired into web or worker. No live Google call has been made.**

## Components

| Piece | Location | Role |
|---|---|---|
| `ToolCallingModelAdapter` | `packages/ai-providers/src/tool-calling.ts` | Model proposes calls; output treated as untrusted (see `model-tool-calling.md`) |
| `ConnectToolRuntime` | `packages/connect-runtime/src/runtime.ts` | The only thing that turns a proposal into an external call |
| `calendar.find_availability` | `packages/connect-runtime/src/google-calendar-tool.ts` | Wraps the existing `GoogleFreeBusyProvider` (`@tugpt/appointments`) |
| `BrokerClient` | `packages/credential-broker/src/client.ts` | HMAC-signed calls to the internal broker; typed results, no throws |

```mermaid
sequenceDiagram
  participant U as User / Agent
  participant M as Model (Langdock)
  participant R as ConnectToolRuntime (worker)
  participant D as connected_accounts / grants / policy
  participant B as credential-broker (internal)
  participant G as Google freeBusy
  U->>M: "@Google Calendar find 30 min tomorrow"
  M-->>R: tool_call calendar_find_availability(args)
  R->>D: connection (org-scoped), policy, owner, grant, status, scope
  alt any check fails
    R-->>M: {ok:false, error:CODE, message:static}
  else all pass
    R->>R: validate args (schema + 14-day window + future + IANA tz)
    R->>B: get_access_token(org, connection) [signed, caller=worker]
    B-->>R: access token (never refresh token)
    R->>G: POST freeBusy (primary)
    G-->>R: busy blocks
    R-->>M: {ok:true, data:{slots}}
  end
  R->>D: audit event (hash of args, outcome, duration)
```

## Check order (fail closed; no credential before authorization)

1. Registered tool → else `UNKNOWN_TOOL`. The admin MCP bridge is never registered (ADR-020 A1.3).
2. Connection found **within the caller's org** → else `CONNECTION_NOT_FOUND`. This is checked again on the returned row, so a directory that drops the org filter still cannot leak.
3. Provider matches the tool → else `PROVIDER_MISMATCH`.
4. Org policy enables the capability → else `POLICY_DISABLED`.
5. A personal connection may only be used by its owner → else `NOT_GRANTED`. Sharing is deferred.
6. An explicit grant exists for the actor or agent and the capability → else `NOT_GRANTED`.
7. Status is `connected` → else `REAUTHORIZATION_REQUIRED` or `CONNECTION_NOT_ACTIVE`.
8. The connection holds an accepted scope (`calendar.freebusy`, or the superset `calendar.readonly`) → else `SCOPE_MISSING`.
9. A write-risk tool → `APPROVAL_REQUIRED`. The approval flow is not in this slice.
10. Arguments are valid → else `INVALID_ARGUMENTS`.
11. The broker token is issued → else `REAUTHORIZATION_REQUIRED` or `PROVIDER_UNAVAILABLE`.
12. The output is at most 8 KiB → else `OUTPUT_TOO_LARGE`.

Multiple calls in one turn run **serially**, capped at 8 per turn (`CALL_BUDGET_EXCEEDED`). A refused call does not abort the others. Each call writes exactly one audit event. Messages returned to the model are static, so provider error text never reaches it.

## Test evidence

- `packages/connect-runtime`: 36 tests. These cover end-to-end via the real broker HTTP server, all 10 authorization refusals (each asserting zero token requests and zero Google calls), 9 argument-validation cases, a broker-side revoke, Google 401/500, serial execution (max in-flight = 1), the call budget, the approval gate, the output cap, handler exceptions, audit-sink failure, and the registry shape accepted by the model adapter.
- Mutation checks: each of the following made at least one test fail:
  - removing the org re-check
  - removing the owner check
  - removing the scope check
  - removing the risk gate
  - parallel execution
  - removing the grant check
  - fetching the token before authorization (21 failures)
- `packages/credential-broker`: `client.test.ts` adds 10 tests against the real server, for 56 in total.

## Not done / next

- **Wiring.** Postgres implementations of `ConnectionDirectory`, `IntegrationPolicy`, `GrantChecker` and `ToolAuditSink` over migration `20261112000001`. Also the worker composition root and the chat `@` picker.
- **Postgres `CredentialStore`** for the broker (currently `InMemoryCredentialStore`).
- **Live test.** Needs an owner-provisioned **staging** Google OAuth client and a dedicated test Google account. The production credential stays untouched (owner decision #4).
- **Seeded capability row.** `calendar.find_availability` is seeded with `is_available=false`. Flip it only after the live staging test.

## Customer MCP transport contract (chat execution and snapshot discovery)

`packages/connect-runtime/src/external-mcp-tool.ts` speaks MCP Streamable HTTP (spec 2025-06-18) through
one routine, `openMcpSession`, used by both `createExternalMcpTool` (chat) and `listExternalMcpTools`
(snapshot discovery):

| Step | Rule |
|---|---|
| Transport | `endpoint.fetchFn` (the egress-proxy fetch) is **required**. `createExternalMcpTool` throws at construction without it; there is no default or global fetch. Redirects are never followed. |
| `initialize` | Request id 1; only HTTP 200 is accepted. |
| Session id | **Only** the `Mcp-Session-Id` response header of `initialize`. It must be visible ASCII (1-256 chars). It is sent on every later message. Without the header the server is stateless and no session header is sent. Nothing in the result body is ever used: before M5, `createExternalMcpTool` read `result.sessionId` (never the header), so it sent no session to spec-compliant servers, which reject that with 400. Discovery fell back to the body value. |
| `notifications/initialized` | A notification: **no `id`**. Must be answered 2xx (202 per spec); anything else aborts the call before `tools/call`. It was previously sent with `id: 2` and its failure was swallowed. |
| Replies | JSON or SSE. SSE events are split on blank lines, multi-line `data:` is joined, and server notifications in the stream are skipped. The response must be `jsonrpc: "2.0"` with **this request's id** and an object `result`. A JSON-RPC `error`, `isError: true`, or non-array `content` fails the call. |
| Result | Only `type: "text"` parts with string `text` are returned to the model. Every failure is `PROVIDER_UNAVAILABLE`, and the chat layer audits it as such. |

Each chat tool call opens a fresh session. Tests: `external-mcp-session.test.ts` (in-memory transport
double implementing the server side strictly) and `apps/web/src/lib/chat/mcp-chat.test.ts` ("MCP
session contract over real sockets": real TLS, the real CONNECT egress path through the proxy double,
and the harness server that enforces the contract).

### Which database identity does what (chat MCP path)

Found by the M5 real-PostgREST chat run (`agent2-takeover/evidence/m5/http-chat-run1-before-fixes.txt`):
with the unit-test fake, both of these passed; against the real database every customer MCP tool was
unusable.

| Step | Client | Why |
| --- | --- | --- |
| Runnable endpoints (`runnableEndpoints`) | member (`authenticated`) | reads only `id, organization_id, status`; `url` and `auth_connection_id` are hidden from members (20261115000012) and selecting them is a 42501 for the whole query |
| Endpoint URL + tool list (`resolve_mcp_execution`) | trusted (`sso_control`) | SECURITY DEFINER; since 20261120000003 it also requires `auth_connection_id IS NULL` (no stored credential), so that rule lives on the trusted path, not in a member read |
| Audit (`record_mcp_tool_call`) | trusted (`sso_control`) | the actor is a parameter (20261115000013+), so only the trusted identity may execute it; the actor is the server-resolved session user. No trusted client means no sink and the gate stays closed (`AUDIT_UNAVAILABLE`) |
| Approvals (`record_tool_approval`, `claim_tool_approval`) and capabilities | member | `auth.uid()` decides; owner/admin only for recording |

The test fake (`mcp.test-harness.ts`) mirrors these grants (`AUTHENTICATED_COLUMN_GRANTS`, trusted-only
RPCs, `fakeTrustedDb`) so a regression fails in unit tests, not only against a real database.
