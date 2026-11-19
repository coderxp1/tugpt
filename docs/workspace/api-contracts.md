# Workspace API contracts

> **Status (Agent 3 milestone 2).** C-2, C-3 and C-4 now exist on Agent 4's branch
> (`feat/workspace-backend-agent4`, `docs/workspace/backend-api.md`), and the UI uses them
> through Agent 4's client. They are kept below for history. Open: **C-1 Agents** (full contract
> below), **C-4b** (attachment content read by the model), **C-6** (approval summary) and C-5.
> Coordination: [agent4-coordination.md](./agent4-coordination.md).

These are the server contracts the Workspace needs and does not have. The UI ships typed
adapters that report "not available" until each exists. All endpoints: session required
(proxy 401), tenant resolved from the session, RLS on every query, errors as
`{ "error": { "code": string, "message": string } }`, mutations require the CSRF header used by
the existing chat routes.

## C-1 Agents (open; UI ready)

Errors follow Agent 4's convention `{ "error": CODE }`; mutations require `x-tugpt-csrf: 1` and a
same-origin `Origin`. The UI client is `lib/workspace/custom-agents.ts`; it probes
`GET /api/v1/agents` and keeps Save disabled (with the reason) until that answers `{ agents: [] }`.

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/api/v1/agents` | – | `200 { agents: CustomAgent[] }` (visible to me: mine + organization) |
| POST | `/api/v1/agents` | `AgentInput` | `201 { agent }` |
| PATCH | `/api/v1/agents/{id}` | `Partial<AgentInput>` | `200 { agent }` (owner only; others `404`) |
| DELETE | `/api/v1/agents/{id}` | – | `200 { deleted: true }` (owner or org admin) |

```ts
interface CustomAgent {
  id: string; name: string; description: string | null;
  instructions: string;          // 1..8000 chars, stored as system instructions
  modelKey: string | null;       // must be in the chat catalogue; null = person's choice
  starters: string[];            // ≤ 4, each ≤ 200 chars
  collectionIds: string[];       // ≤ 10 Library collections the caller can read
  visibility: 'private' | 'organization';
  ownedByMe: boolean; createdAt: string; updatedAt: string;
}
type AgentInput = Pick<CustomAgent, 'name'|'description'|'instructions'|'modelKey'|'starters'|'collectionIds'|'visibility'>;
```

Error codes: `INVALID_REQUEST`, `INVALID_MODEL`, `INVALID_COLLECTION` (unknown or not readable:
same answer, no existence leak), `LIMIT_EXCEEDED`, `NOT_FOUND`, `FORBIDDEN`. RLS: owner, or any
member of the tenant for `organization`. Retrieval over `collectionIds` must re-check the
**caller's** access at query time (not the creator's). Chat: `POST /api/v1/chat/threads` accepts
an optional `agentId`; the messages route applies the agent's instructions, model and
collections. Later: versions, publish, test runs.

## C-2 Server-side thread search

`GET /api/v1/chat/threads?q=<text>&cursor=<opaque>&limit=<1..50>` →
`200 { threads: Thread[], nextCursor: string | null }`. Matches title and message text
(unaccent, case-insensitive), owner-only via RLS. Until then the sidebar filters the loaded 50.

## C-3 Rename and delete a thread

- `PATCH /api/v1/chat/threads/[id]` body `{ title: string (1..120) }` → `200 { thread }`
- `DELETE /api/v1/chat/threads/[id]` → `204`. UI must confirm first (consequential action).
Not-owner ⇒ `404` (same as not found). Audit-logged.

## C-4 File upload

`POST /api/v1/files` (multipart, ≤ admin-configured size, type allow-list) →
`201 { file: { id, name, size, mimeType, status: 'processing' | 'ready' | 'rejected' } }`,
stored in tenant-scoped object storage with malware scan and text extraction; messages accept
`fileIds: string[]`. Until then text files are inlined (≤ 5 × 64 KB, 8,000 chars total).

## C-5 Shared prompt library

`GET /api/v1/prompts` → `200 { prompts: { id, title, body, visibility, ownerId, updatedAt }[] }`
with private/organization visibility in RLS. Until then the Library shows built-in starters only
(by key; the URL never carries prompt text).

## Optional: model preference

`GET/PUT /api/v1/me/preferences { defaultModelKey }` so the choice survives devices. Today the
choice lives in the page session only.

## C-4b Attachment content in chat (open)

The messages route should include the text of files attached to the thread (Agent 4's
`thread_attachments`) in the model context, within a per-turn budget, with a marker the UI can
render as a citation. Until then the composer and "Files in this chat" say that the assistant
does not read uploaded documents yet.

## C-6 Approval summary (open)

`GET /api/v1/approvals/summary?since=<iso>` → `200 { pendingForMe, pendingInOrg | null,
decidedSince: { id, status, capability, endpointName, decidedAt }[] }`. Replaces the UI's
45-second list polling (`useApprovalFeed.ts`) with a cheap counter; SSE later.
