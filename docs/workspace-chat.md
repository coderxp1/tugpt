# Workspace chat and @-connectors

Status: implemented on `feat/workspace-v1`, verified locally on the isolated
stack `tugpt-connect-p0`. **Not applied to any hosted database.**

## What it is

`/dashboard/chat` is the TuGPT workspace chat: threads, streaming answers, model
choice, and `@` mentions that let the assistant use a connected app for one
message. `/dashboard/connect` shows which apps exist and their state for the
signed-in user. Both are fed by the same database function, so the picker and
the Connect page can never disagree.

## Data model (migration `20261115000001_workspace_chat.sql`)

| Object | Rule |
|---|---|
| `chat_threads` | Visible and writable only by the owner, and only while the owner is an active member of the thread's organization. Only `title`, `model_key` and `updated_at` are updatable. |
| `chat_messages` | Composite FK to `(organization_id, thread_id)`; append-only (no UPDATE/DELETE grant); roles `user`, `assistant`, `tool`. |
| `connect_tool_calls` | Append-only audit of every tool invocation. The actor reads their own rows; owners/admins read their organization's. |
| `record_connect_tool_call()` | SECURITY DEFINER. Actor is always `auth.uid()`. Rejects non-members, threads the caller does not own, and connections that are not usable. |
| `list_chat_capabilities(org)` | SECURITY INVOKER. Returns each capability with a state: `connected`, `requires_connection`, `disabled_by_policy`, `not_available`. |

Seeds: Google Workspace `calendar.find_availability` (existing) and Microsoft 365
`calendar.find_availability` (`Calendars.ReadBasic`). Both providers are
**unavailable by default**; they become `requires_connection` only when an
administrator rolls them out.

## Request path

```
browser ──same-origin POST──▶ /api/v1/chat/threads/:id/messages
  proxy: session required (protected route, 401 JSON)
  handler: chatContext() → user + strict tenant (stale hint = 403)
           RLS client only — no service-role key in the request path
           @mentions re-validated against list_chat_capabilities()
           runTurn(): ≤2 tool rounds, duplicate calls collapsed,
                      tool output passed as untrusted data
           tool call → ConnectToolRuntime → credential broker (caller "web")
                    → record_connect_tool_call() (fail-closed)
  ◀── NDJSON stream: delta | tool | done | error
```

## Configuration (server environment only)

| Variable | Purpose |
|---|---|
| `TUGPT_PRIVATE_LLM_URL`, `TUGPT_PRIVATE_LLM_MODEL` | TuGPT Scout on the private GPU (OpenAI-compatible). Plain `http` is accepted only for loopback. |
| `LANGDOCK_API_KEY` | Optional. Langdock-hosted models appear only when it is set. |
| `TUGPT_BROKER_URL`, `TUGPT_BROKER_CALLER_KEY` | Credential broker for connector tokens (same names as `packages/connect-server`). The key is **hex**, at least 32 bytes; caller is `web`. Missing or malformed values mean every tool returns `UNAVAILABLE`; chat still works. The old `TUGPT_CREDENTIAL_BROKER_*` names are no longer read. |
| `TUGPT_CHAT_VERIFIED_TOOL_MODELS` | Comma-separated chat model keys (e.g. `tugpt-scout`, `langdock:<model>`) that passed the staging tool-calling probe (`docs/connect/model-tool-calling.md`, `recommendedVerifiedModels`). **Empty by default: no model gets tools**, the @ picker explains why, and the messages route returns 409 `This model cannot use integrations`. |

| `TUGPT_CUSTOMER_MCP_ENABLED` | Connect UI switch for customer MCP servers. **Off unless exactly `true`.** Must stay off until the egress proxy passes its probe and discovery is routed through it (B-8 in `docs/dashboard/connect-frontend.md`). Chat needs this **and** `TUGPT_CHAT_MCP_EXECUTION_ENABLED` (see "Customer MCP in chat" below). |
| `TUGPT_CHAT_MCP_EXECUTION_ENABLED` | Running customer MCP tools from chat. **Off unless exactly `true`.** Separate from the Connect switch, so enabling MCP management in Connect never runs MCP tools from chat by itself. |

Endpoints and keys never reach the browser (`publicModels()` strips them).

### Tools in chat

- Registered: Google and Outlook calendar availability (read-only), from `createBuiltInCalendarTools()`.
- Only one calendar per message: both use the model name `calendar_find_availability`; the messages route returns 409 `Attach one calendar per message`.
- Non-read tools go through `claim_tool_approval()`; any error or missing approval is "not approved" (`APPROVAL_REQUIRED`). For MCP tools chat then shows an approval card (B-11, below).
- Stream events `tool_start`/`tool_result` carry `callId` and `provider` (the capability row's provider name, never model output). The client treats a stream without `done`/`error` as interrupted.

## Not done yet

- OAuth v2 start/callback for Google and Microsoft through the broker. The
  existing `/api/v1/integrations/*` routes are blocked at the proxy with
  `503 privileged_bridge_pending_review`.
- A Google OAuth client and an Entra app registration (owner action).
- Running credential broker on the VPS.

## Customer MCP in chat (B-9)

Code: `apps/web/src/lib/chat/mcp.ts` (registry and gate), `mcp-egress.ts`
(proxy transport), `connect.ts` (toolset). Tests: `mcp-chat.test.ts`,
`mcp-egress.test.ts`, `capabilities-route.test.ts`.

**Gate (fail closed, checked on every registry load).** MCP tools are offered
only if all hold; otherwise every MCP row is `toolAvailable: false`:

1. `TUGPT_CUSTOMER_MCP_ENABLED` is exactly `true` (reason code `MCP_FEATURE_OFF`).
2. `TUGPT_CHAT_MCP_EXECUTION_ENABLED` is exactly `true` (`MCP_CHAT_EXECUTION_OFF`).
3. `CONNECT_EGRESS_PROXY` parses as a plain `http://host:port` proxy (`MCP_EGRESS_NOT_CONFIGURED`).
4. An `McpAuditSink` exists (`MCP_AUDIT_UNAVAILABLE`). Production uses Agent 2's
   `createMcpAuditSink` (`record_mcp_tool_call`, migration
   `20261115000006_mcp_audit.sql`) on the caller's RLS client. If a write fails,
   the result is withheld.

`GET /api/v1/chat/capabilities` returns the reason as `unavailableReason` on MCP
rows. The @ picker shows it, for example "Not available in chat yet: running
custom tools from chat is switched off". A row behind an open gate that still
isn't runnable gets `MCP_NOT_RUNNABLE`.

**Which tools.** Agent 2's `listActiveMcpTools` (RLS-bound client), intersected
with endpoints that are in the caller's organization, `active`, have no
`auth_connection_id` (no credential path exists), and whose *newest* snapshot is
approved and not revoked (Agent 2's helper falls back to an older approved
snapshot while a newer one is pending; chat does not). Tools with an invalid
name, unknown permission class or non-object schema are dropped.

**Each call.** The grant re-checks the same endpoint, tool and stored
permission class against the database; `createExternalMcpTool` runs with the
proxy-only fetch (CONNECT tunnel, TLS verified, https only, no redirects, 1 MB,
15 s) and its SSRF floor. Read tools run directly. Every other class is `write`
risk, so the runtime claims a single-use approval through
`claim_tool_approval` (exact org, endpoint, capability and argument hash; not
expired, used or revoked). No MCP credential is sent. If the audit record fails,
the result is withheld and the call reports `INTERNAL`; the same now holds for
built-in tools.

**Messages.** Tool messages for MCP calls store `capability_key = null`
(`chat_messages.capability_key` references the built-in catalogue).

## Approving one MCP call in chat (B-11)

Code: `lib/chat/approval.ts` (browser: parser, redaction, API clients, state),
`lib/chat/approval.server.ts` (argument hash), `components/chat/ApprovalCard.tsx`,
`app/api/v1/chat/threads/[threadId]/approved-call`, `app/api/v1/chat/approvals/status`.
Tests: `approval.test.ts`, `ApprovalCard.test.tsx`, `approval-routes.test.ts`,
`ChatWorkspace.test.tsx`, `mcp-chat.test.ts` ("chat approvals").

1. When the runtime refuses an MCP call with `APPROVAL_REQUIRED`, the messages
   route sends `{type:'approval_required', approval}` right after the
   `tool_result`. The payload contains the endpoint name, the endpoint **host
   only** (no path or query string), the tool, the description, the stored
   permission class, the arguments, and `argumentsSha256`. Everything except
   the arguments comes from server-side rows. The hash is computed the same way
   as the runtime's claim and audit hash (sha256 of canonical JSON); a test
   checks it against the runtime's own audit event.
2. The card explains the effect of the permission class and shows the
   arguments. Values under secret-like keys (token, secret, password, API key,
   authorization, cookie, session, credential, private, signature, ...) and
   credential-shaped values (Bearer, JWT, `sk-...`, `ghp_...`, PEM keys) are
   replaced with "Hidden" and never put into the DOM. Long values are
   shortened, and depth and line count are limited. The raw arguments stay in
   browser memory because they must be sent back for the run.
3. Owners and admins pick a lifetime (5 min, 15 min or 1 h), tick a
   confirmation box, and press **Approve**. The card calls Agent 2's
   `POST /api/v1/connect/mcp/approvals`. It counts as approved **only** for
   HTTP 200 with `{approved:true}` **and** a follow-up `is_tool_approved()`
   check (status route) that returns `true`. Any other status, body or network
   error shows a failure and never enables **Run now**. **Reject** closes the
   card without a request. **Revoke approval** calls
   `POST /api/v1/connect/mcp/approvals/revoke`; `{revoked:false}` is reported
   as "nothing left to revoke". A failed revoke says the approval stays valid.
4. **Run now** posts to `approved-call`. That route re-validates the thread,
   the capability row, the MCP gate, the runnable endpoint and tool, and the
   model. It recomputes the argument hash (409 if it differs), accepts only
   non-read MCP tools, and executes through the Connect runtime, which claims
   the approval atomically. The model gets no tools in that turn. A refused
   claim (expired, revoked, already used, or different arguments) shows "Not
   run".
5. The countdown is a client-side estimate: the approval route returns no
   expiry time. When it reaches zero the card shows "expired". The database
   enforces the real expiry either way.
6. Members see the card without Approve. Chat has no way to send an approval
   request to an owner or admin yet, so the card says so. **Check again** only
   reads the status.

Known limits: approval cards are not stored, so reloading the thread drops
them, although the refused tool step stays in the history. The runtime claims
the approval before it executes, so a call that then fails (for example, the
proxy is down) still uses up the approval.

