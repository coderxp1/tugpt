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

Endpoints and keys never reach the browser (`publicModels()` strips them).

## Not done yet

- OAuth v2 start/callback for Google and Microsoft through the broker. The
  existing `/api/v1/integrations/*` routes are blocked at the proxy with
  `503 privileged_bridge_pending_review`.
- A Google OAuth client and an Entra app registration (owner action).
- Running credential broker on the VPS.
