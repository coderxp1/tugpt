# Agent 3 ↔ Agent 4: Workspace API coordination

Agent 3 (Workspace UI, branch `feat/workspace-agent3`) builds against Agent 4's backend contract
(`feat/workspace-backend-agent4` @ `710f8a6`, `docs/workspace/backend-api.md`). This file lists
what the UI uses, the questions we need answered, and the gaps the UI handles today with an
explicit "not available yet" state.

## What the UI uses, exactly

The UI calls only Agent 4's typed client. `apps/web/src/lib/workspace-data/{contracts,errors}.ts`
are vendored **byte for byte** from `710f8a6`, so the two branches merge without conflicts.
The UI's own layer is `lib/workspace/service.ts` (problem classification and messages).

| UI | Client calls | Notes |
|---|---|---|
| Sidebar: folders, rename, move, archive + undo, delete, archived view | `listFolders`, `listConversations({archived,limit})`, `updateConversation`, `deleteConversation`, `createFolder`, `renameFolder`, `deleteFolder` | Probed with `GET /chat/folders`. Without `{folders: []}` the sidebar stays as before |
| Sidebar search | `listConversations({q, limit: 30})` | 250 ms debounce, ≥ 2 characters. Shows `snippet` when `matchSource === 'message'`. Falls back to the local filter if the response has no `nextCursor` (older route) |
| Composer uploads | `uploadFile(blob, name)` then `attachFile(threadId, fileId)` | Small text files still go inline. Declared type comes from the extension (browsers send `""` for `.md`) |
| "Files in this chat" | `listAttachments`, `fileContentUrl` | Only shown when there is at least one attachment |
| Approvals page and nav badge | `listApprovals({scope, status, limit, before})`, `actOnApproval` | Admins: `scope=org&status=pending`. Members: `scope=mine`. Polled every 45 s while the tab is visible |
| Library collections | `listCollections`, `createCollection`, `getCollection`, `updateCollection`, `deleteCollection`, `uploadFile(…, collection.visibility)`, `addDocument`, `reindexDocument`, `removeDocument`, `search` | Detail view polls every 5 s while any document is `pending`/`indexing` |

## How the UI decides that something is unavailable

| Response | UI meaning |
|---|---|
| `404`/`405`/`501` with a non-JSON body (Next's HTML 404 → `UNEXPECTED_RESPONSE`) | Route not deployed → calm "not available in this workspace yet" |
| `503 STORE_UNAVAILABLE` / `STORAGE_NOT_CONFIGURED` / `STORAGE_UNAVAILABLE` | Not configured → same, and file storage is named in the message |
| `200` without the expected array (`folders`, `approvals`, `collections`, `hits`, `attachments`) | Older route → unavailable |
| `404 NOT_FOUND` (JSON) | Real "not found / no access" |
| `401` | Signed out → sign-in link. `403` → no permission (no retry button) |

**Please keep these shapes stable**, in particular: an unknown route must never answer `200` with
an empty body, and storage that is not configured must stay `503` with the code.

## Questions and requests for Agent 4

| # | Topic | Request | Why |
|---|---|---|---|
| Q-1 | `reindexDocument` body | The client sends `{ "action": "reindex" }`; `backend-api.md` says the body is "none". Please confirm the route accepts this body (strict allowlists would `400`), or change the client and doc together | Avoid a silent 400 on Reindex |
| Q-2 | Approval notifications | `GET /api/v1/approvals/summary` → `{ pendingForMe: number, pendingInOrg: number \| null, decidedSince: { id, status, capability, endpointName, decidedAt }[] }` with `?since=<iso>` | Replace 45 s list polling (50 rows) with a cheap counter. SSE or a notification row later |
| Q-3 | Attachment content in chat (C-4b) | Messages route reads attached files (text extraction) into the model context, with per-file token budget and a citation marker | Today the UI must say "the assistant does not read uploaded documents yet" |
| Q-4 | PDF extraction | Replace `PDF_EXTRACTION_UNAVAILABLE` with real extraction (or OCR worker) | PDFs are the most common business document |
| Q-5 | Collections in chat context | Use `thread_collections` links in the messages route (retrieval with source permissions, citations) | Linking exists; retrieval does not |
| Q-6 | Agents API (C-1) | See `api-contracts.md` § C-1. The UI's client is `lib/workspace/custom-agents.ts` | Builder is ready; saving is disabled until `GET /api/v1/agents` answers `{ agents: [] }` |
| Q-7 | Search cursor | `listConversations({ q })` returns `nextCursor`; the UI shows the first 30. Confirm ordering (rank vs `updatedAt`) so "Load more" can be added safely | Paging semantics |

## Not needed from Agent 4

Folder ordering (the UI sorts by name, locale-aware), undo (the UI re-PATCHes `archived:false`),
and the delete confirmation (UI-side `alertdialog`).
