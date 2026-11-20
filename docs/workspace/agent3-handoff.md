# Agent 3 handoff – workspace API contract (integration branch)

Branch `integration/workspace-agent4-q678` (Q-6 + Q-6b, Q-7, Q-8 + Q-8b).
All routes are under `/api/v1`, scoped to the caller's current organisation.
Mutations need the same-origin headers (see `operations.md` §3).
Set `agentsApiAvailable = true`; the client already accepts any 2xx.

## Error body

`{ "error": "<CODE>" }`. Codes include `INVALID_REQUEST`, `LIMIT_EXCEEDED`,
`INVALID_COLLECTION`, `INVALID_MODEL`, `CONFLICT`, `RATE_LIMITED` (429 +
`Retry-After`). Thread/agent-run routes use human-readable messages instead
(see below).

## CustomAgent

```ts
{ id, name, description, instructions /* '' unless ownedByMe */, modelKey,
  visibility /* 'private' | 'organization' */, tools, starters,
  collectionIds /* only collections the caller can read */,
  ownedByMe, canEdit, canDelete, version, createdAt, updatedAt }
```

Limits: name ≤ 80, description ≤ 280, instructions 1..8000, starters ≤ 4 × 200
chars, collections ≤ 10. `version` does not bump on links-only saves.

| Operation | Success | Errors |
|---|---|---|
| `POST /agents` | 201 agent | 400 validation; 403 org visibility by member/viewer |
| `PATCH /agents/:id` | 200 agent | owner only; anyone else 404 (admins included) |
| `DELETE /agents/:id` | 200 | owner, or org owner/admin for org agents; other readers 403 |
| `POST /agents/:id/collections` `{collectionId}` | 201 `{linked:true}` (also when already linked) | non-owner 403; unreadable collection 404; 11th link 400 `LIMIT_EXCEEDED` (race-safe) |
| `DELETE /agents/:id/collections/:cid` | 200 | non-owner 403; unknown or unreadable collection 404 |
| `POST /agents/:id/run` | 200 NDJSON stream | see thread messages below |

## Threads

- `POST /chat/threads` `{modelKey?, agentId?}` → 201
  `{thread:{id,title,modelKey,updatedAt,agentId}}`; 404 "Agent not found";
  400 "Unknown model" / "Invalid request".
- List/search: response has `nextCursor` (opaque, starts `c1.`); pass it back
  as `before`. `limit` ≤ 100. Bad cursor → 400. Plain `GET /threads` without
  search has no cursor.
- Agent-thread messages: 409 "This agent is no longer available to you";
  archived thread 404; a deleted agent turns the thread into plain chat.
- **Reload (Q-9):** `GET /chat/threads/:id` →
  `{thread:{id,title,modelKey,updatedAt,agentId}, messages:[{id,role,content,
  createdAt,status,mentions,capabilityKey,citations,knowledgeUnavailable}]}`.
  `citations` has the same shape as the stream event and equals the `done`
  message. `agentId` is `null` for plain chat or a deleted agent; a binding to
  an agent you can no longer read is still returned (then `GET /agents/:id`
  404, send 409). Citations whose document the reader can no longer read are
  omitted (not redacted); user/tool messages always have `[]`/`false`. The
  plain list and `POST` include `agentId`; the search/paged list does not yet.
  Restoring this into the UI and validating it is Agent 3's task.
  Q-9b (migration 20261120100011): the database now rejects `[{}]` and every
  other malformed citation shape; the API contract is unchanged.

## Stream events (NDJSON, one object per line, `type` field)

| type | payload |
|---|---|
| `agent` | `{agent:{id,name,version}, thread, unavailableTools}` |
| `user` | `{message}` |
| `citations` | `{citations:[{n,documentId,collectionId,fileId,title,ordinal,snippet}], knowledgeUnavailable}` |
| `delta` / `tool_start` / `tool_result` / `approval_required` | unchanged from core chat |
| `done` | `{message}` |
| `error` | `{code, message?}` |

## Library documents

`POST /library/collections/:cid/documents` `{fileId, title?}`:

- **202** `{document, created:true}` – new document, indexing queued.
- **200** `{document, created:false}` – same file already in this collection.
  Returns the same full document and the canonical id; the title is **not**
  renamed. Safe to retry after a lost response.
- 409 `CONFLICT` – file not ready yet. 403/404 – no access to the collection.
- Dedupe is per tenant + collection; deleting a document frees the slot
  (re-add → 202, new id).

## Q-9c security fixes (Agent 4) — no frontend change needed

The HTTP API is unchanged: same routes, request bodies, response shapes and
stream events. `agent.instructions` is still `''` for callers who cannot edit
the agent, and `messages[].citations` still shows only sources the reader can
read now. What changed is where this is enforced. The database no longer lets
a signed-in user read `custom_agents.instructions` or
`chat_messages.citations` directly, or insert assistant/tool messages. The
API reads and writes those through new database functions. No new error mode
(measured, Q-10): a deployment without `GRANT sso_control TO authenticator`
cannot load sessions at all. Every protected request is
`503 {"error":"temporarily_unavailable"}`, as before Q-9c. If a function call
fails transiently, a chat answer still ends with
`{"type":"error","code":"STORE_UNAVAILABLE"}`, which the UI already handles.
Since Q-10 the same web build also works on a database without the Q-9c
migrations, with identical responses. No UI change.
