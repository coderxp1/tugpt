# Workspace backend API (conversations, approvals, files, library, agents)

Owner: Agent 4 (`feat/workspace-backend-agent4`). Consumer: Agent 3 (Workspace UI).
Separate from Connect/MCP routes: nothing here changes `/api/v1/connect/*` or Agent 2's MCP code.

**Types and client:** `apps/web/src/lib/workspace-data/contracts.ts` is the source of truth. It exports
every request and response type, the `WORKSPACE_API` path table and `createWorkspaceClient(fetch)`. The
client returns `{ ok: true, value } | { ok: false, status, error }` and never throws for HTTP errors.
If you're writing UI code, import the client; don't hand-roll fetches.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | The session cookie. The tenant comes from `chatContext` (session plus optional tenant hint). A hint for an org you don't belong to returns **403** before any handler runs. |
| Tenant isolation | Every query is scoped by `organization_id` **and** enforced again by Postgres RLS / `SECURITY DEFINER` membership checks. Tests prove a forged tenant (user B claiming org A) is rejected by the database itself. |
| Mutations (CSRF) | Every non-GET needs `Origin` equal to `TUGPT_APP_ORIGIN`, the header `x-tugpt-csrf: 1`, and no `Sec-Fetch-Site: cross-site`. Otherwise you get `403 INVALID_ORIGIN`. The client does all three. |
| JSON bodies | Strict allowlist per route. Unknown fields return `400 INVALID_REQUEST`. |
| Errors | `{"error": "<CODE>"}` (section 7). Messages are never raw database or storage text. |
| Not-found vs forbidden | If you can't see a resource, you get **404**, whether it is foreign or missing, so IDs can't be enumerated. If you can see it but may not change it, you get **403**. |
| Caching | All JSON is `Cache-Control: private, no-store`. |
| Pagination | `?limit=` (bounded per route) and `?before=<ISO timestamp>`. Responses include `nextCursor`, which is `null` on the last page. |
| IDs | UUIDs. A malformed ID in the path returns 404. |

Roles: `owner`, `admin`, `agent` (member) and `viewer`. "Admin" below means owner or admin.

## 2. Conversations

| Method & path | Body / query | Success | Who |
|---|---|---|---|
| `GET /api/v1/chat/threads` | `q`, `archived` (bool, default false), `folderId`, `unfiled`, `limit` ≤100, `before` | `200 {threads: Conversation[], nextCursor, models}` | own threads only |
| `PATCH /api/v1/chat/threads/{id}` | `{title?, archived?, folderId?: uuid\|null}` (at least one) | `200 {thread}` | owner of the thread |
| `DELETE /api/v1/chat/threads/{id}` | none | `200 {deleted: true}` (messages, attachment links and collection links cascade) | owner of the thread |
| `GET /api/v1/chat/folders` | none | `200 {folders: Folder[]}` | own |
| `POST /api/v1/chat/folders` | `{name}` ≤80 chars | `201 {folder}`. `409 ALREADY_EXISTS` for a case-insensitive duplicate; `429 LIMIT_EXCEEDED` beyond 200 | any member (folders are personal) |
| `PATCH /api/v1/chat/folders/{id}` | `{name}` | `200 {folder}` | own |
| `DELETE /api/v1/chat/folders/{id}` | none | `200 {deleted: true}`. Threads become unfiled, not deleted | own |

- **Search:** `q` matches titles (case-insensitive) and message text (Postgres full-text search). Each hit has
  `matchSource: 'title'|'message'` and a plain-text `snippet` with no markup, so you can render it as text.
- **Backward compatibility:** `GET /chat/threads` with **no** query parameters keeps its legacy response. The
  client always sends `archived`, so it always gets the new shape.
- **Folders:** you can only file a thread into your own folder in the same org. The database enforces this
  with a composite FK; any other folder returns 404.
- Conversations are private to their owner. Org owners and admins do **not** see members' threads.

## 3. Approvals (persistent)

These extend Agent 2's MCP approvals; they don't replace them. A **request** can exist before anyone
approves it. Approving calls Agent 2's `record_tool_approval`, so the runtime's existing
`claim_tool_approval` consumes the result unchanged. Revoking calls `revoke_tool_approval`.

| Method & path | Body / query | Success | Who |
|---|---|---|---|
| `POST /api/v1/approvals` | `{threadId, connectionId, capability: 'external.<tool>', arguments: object ≤16KB, reason?}` | `201 {approval}`. An identical pending request is **returned, not duplicated** | requester must own the thread |
| `GET /api/v1/approvals` | `scope=mine\|org` (org: admin only), `status`, `limit` ≤200, `before` | `200 {approvals, nextCursor}` | members (own); admin (org) |
| `GET /api/v1/approvals/{id}` | none | `200 {approval}` | requester or admin |
| `POST /api/v1/approvals/{id}` | `{action:'approve', ttlSeconds? 60–3600 (default 900), note?}` · `{action:'reject', note?}` · `{action:'cancel'}` · `{action:'revoke'}` | `200 {id, action, changed, toolApprovalId, approvalExpiresAt}` | approve/reject/revoke: admin. cancel: the requester only (anyone else gets `changed:false`) |

- **Statuses:** `pending`, `approved`, `rejected`, `cancelled`, `expired` (an unanswered request past its
  deadline, **or** an approval that expired unused), `used` (consumed by the tool call) and `revoked`.
  History also includes Agent 2's direct (card) approvals as `source: 'direct'`.
- **Arguments are never stored.** The server stores `argumentsSha256`, computed with the runtime's
  `argumentsSha256`, so an approval can only be claimed by the exact same call. It also stores a bounded
  (≤12KB) `argumentsPreview` in which secrets are redacted (`api_token`, `password`, bearer values, …).
- **Rules:** only `write`, `irreversible` and `financial` tools need approval. Read tools return
  `400 INVALID_CAPABILITY`. Only the newest approved snapshot of an active endpoint counts. A requester can
  have at most 50 pending requests (`429 TOO_MANY_PENDING`). The requester can't approve their own request
  unless they are an admin.
- **Errors:** `INVALID_THREAD` and `INVALID_ENDPOINT` (400) mean the same thing whether the target is
  foreign or missing. Other errors: `ALREADY_DECIDED` (409), `REQUEST_EXPIRED` (409), `INVALID_TTL`,
  `ARGUMENTS_TOO_LARGE` (413).

## 4. Files

| Method & path | Body / query | Success | Who |
|---|---|---|---|
| `POST /api/v1/files?filename=&visibility=private\|organization` | **raw bytes** as the body; `Content-Type` is the declared type | `201 {file: WorkspaceFile}` | members (viewers: 403). `organization` visibility needs a member or above |
| `GET /api/v1/files` | `scope=mine\|organization`, `limit`, `before` | `200 {files, nextCursor}` | |
| `GET /api/v1/files/{id}` | none | `200 {file}` | owner, or any org member if visibility is `organization` |
| `PATCH /api/v1/files/{id}` | `{filename}` (the extension must stay the same) | `200 {file}` | owner |
| `DELETE /api/v1/files/{id}` | none | `200 {deleted:true}`; also removes the blob and all attachment links | owner; admins for org-visible files |
| `GET /api/v1/files/{id}/content` | none | file bytes | same as GET |
| `GET /api/v1/chat/threads/{id}/attachments` | none | `200 {attachments: [{file, attachedAt}]}` | thread owner |
| `POST /api/v1/chat/threads/{id}/attachments` | `{fileId}` (any file you can read) | `201 {attachment}` | thread owner |
| `DELETE /api/v1/chat/threads/{id}/attachments/{fileId}` | none | `200 {deleted:true}` | thread owner |

**Upload validation, in order:**
1. Size against `TUGPT_FILE_MAX_BYTES`: default 25 MB, hard cap 50 MB (the DB CHECK enforces the cap too). The body is streamed and cut off as soon as it exceeds the cap, so you get `413 PAYLOAD_TOO_LARGE`.
2. Filename is reduced to a safe final segment (path, control and bidi characters stripped; ≤255 characters).
3. The extension must be on the allowlist: txt, log, md, markdown, csv, json, pdf, docx, xlsx, pptx, png, jpg/jpeg, gif and webp. **SVG, HTML and scripts are refused** with `415 UNSUPPORTED_MEDIA_TYPE`.
4. The declared type must be compatible, and the **content is sniffed** (magic bytes; ZIP containers for Office files; UTF-8 without NULs for text). A mismatch returns `415 MEDIA_TYPE_MISMATCH`.

**Downloads:** always `Content-Disposition: attachment`, plus `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`,
`Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`. The bytes are re-hashed on every
download; if they don't match the stored hash, the server returns `503 INTEGRITY_CHECK_FAILED`.

**No storage details leave the server.** No key, path, bucket or URL appears in any response, row
or log. The blob key is derived on the server as `org/<orgId>/files/<fileId>`, and both IDs are validated as UUIDs.

## 5. Knowledge library

| Method & path | Body / query | Success | Who |
|---|---|---|---|
| `GET /api/v1/library/collections` | none | `200 {collections}` (readable ones) | |
| `POST /api/v1/library/collections` | `{name, description?, visibility?: private\|organization}` | `201 {collection}` | private: members; organization: admin |
| `GET /api/v1/library/collections/{id}` | none | `200 {collection, documents}` | readers |
| `PATCH /api/v1/library/collections/{id}` | `{name?, description?, visibility?}` (changing to `organization` needs admin) | `200 {collection}` | writers |
| `DELETE /api/v1/library/collections/{id}` | none | `200 {deleted:true}`. Readable but not writable returns 403 | writers |
| `POST /api/v1/library/collections/{id}/documents` | `{fileId, title?}` | **`202 {document, created: true}`** with `status: 'pending'`; the worker indexes it. **`200 {document, created: false}`** when this file *or the same content* (SHA-256) is already in the collection: the existing document is returned unchanged, so retries never create duplicates | writers; the file must be `ready` and readable (`409 CONFLICT` otherwise). Never indexes in the request |
| `POST /api/v1/library/collections/{id}/documents/{docId}` | `{action: 'reindex'}` | **`202 {document}`** (`pending`, attempts reset) | writers (readers of a foreign private collection get 404) |
| `DELETE /api/v1/library/collections/{id}/documents/{docId}` | none | `200 {deleted:true}` (the file is kept) | writers |
| `GET /api/v1/library/search` | `q` (required, ≤200), `collectionIds=a,b` (optional), `limit` ≤50 | `200 {hits: SearchHit[], semantic: boolean}` | readers |
| `GET\|POST /api/v1/chat/threads/{id}/collections` | POST `{collectionId}` | `200 {collections}` / `201 {linked:true}` | thread owner; the collection must be readable |
| `DELETE /api/v1/chat/threads/{id}/collections/{collectionId}` | none | `200 {deleted:true}` | thread owner |

- **Read/write rules:** private collections belong to their owner only; the org owner can't see them
  either. Organization collections are readable by every member, including viewers, and writable by
  admins and the creator.
- **Processing is asynchronous.** Adding a document inserts it as `pending`; a trigger enqueues a job in
  `private.knowledge_document_jobs`. The knowledge worker (`apps/worker`, `start:knowledge`) leases jobs
  (`claim_document_jobs`, lease + heartbeat), reads the blob, **verifies its SHA-256**, extracts, chunks,
  optionally embeds, and stores chunks and vectors atomically (`complete_document_job`). Poll the
  collection (`GET …/collections/{id}`) for `status`, `errorCode`, `processingAttempts` and `nextAttemptAt`.
- **Statuses:** `pending` → `ready` | `failed` | `unsupported`. Deterministic problems finish immediately:
  `FILE_MISSING`, `FILE_INTEGRITY_FAILED`, `EXTRACTION_FAILED`, `EMPTY_DOCUMENT`, `DOCUMENT_TOO_LARGE`,
  `UNSUPPORTED_FOR_INDEXING`. Transient ones (`STORAGE_UNAVAILABLE`, `DB_UNAVAILABLE`, `STORE_REJECTED`,
  `EMBEDDINGS_UNAVAILABLE` on early attempts) go back to `pending` with `errorCode` set and
  `nextAttemptAt` = now + 30 s·2^(attempt−1), capped at 1 h; after 5 attempts the document is `failed`.
  If embeddings keep failing from attempt 3 on, the document is stored keyword-only rather than lost.
  An expired lease is reclaimed; an exhausted one ends as `PROCESSING_ABANDONED`.
- **Formats:** txt, md, csv, json, log; **DOCX** and **XLSX** (bounded ZIP reader, 20 MB XML cap against zip
  bombs; tracked deletions and field codes dropped; shared strings and inline strings for XLSX); **PDF** via
  pdfjs in the worker (page/char/time limits; image-only or corrupt PDFs end as `EXTRACTION_FAILED`). Chunks
  of about 1,500 characters with 150 overlap, at most 2,000 per document.
- **Search (hybrid):** `search_knowledge_hybrid` is `SECURITY INVOKER`, so chunk and embedding RLS decide per
  row at query time. Full-text uses the `simple` config (language-neutral) with `ts_rank`. When a query
  embedder is configured, the query is embedded (5 s timeout) and fused with the keyword ranking by
  Reciprocal Rank Fusion (k = 60). Each hit carries `match: 'keyword'|'semantic'|'hybrid'`, `keywordScore`
  and `semanticScore` (null when that side did not match). If embedding fails, search silently degrades to
  keyword-only and the response says `semantic: false`. Snippets are plain text.
- **Vector index strategy:** vectors are stored with their model and dimension and only compared within the
  same model + dimension, after pre-filtering by organization (and collection). The column has no fixed
  dimension, because the model is deployment configuration, so there is **no HNSW index by default**: the
  scan is exact. Once a deployment fixes its model, add a partial HNSW index for that dimension in a new
  migration, e.g. `CREATE INDEX … USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WHERE dims = 1024`.
- **No similarity threshold:** semantic search returns the nearest neighbours even when they are not close.
  Treat low `semanticScore` hits accordingly in the UI.

### Upload flow and failure semantics (Q-8)

A Library upload is `POST /api/v1/files` followed by `POST …/documents`. Each step either succeeds or leaves nothing misleading behind:

| Failure | Response | What remains |
|---|---|---|
| Storage write fails | `503 STORAGE_UNAVAILABLE` from `/files` | No file row (removed again), no document |
| Storage not configured | `503 STORAGE_NOT_CONFIGURED` | Nothing |
| File not `ready` (upload still running, or crashed) | `409 CONFLICT` from `…/documents` | No document; stale `uploading` rows are purged by maintenance (§5c) |
| Response of `…/documents` lost, client retries | `200 {created: false}` | One document |
| User drops the same file again (new file id, same bytes) | `200 {created: false}`, existing document | One document; the second *file* stays in the user's files (it is a real upload) |
| No write access | `403 FORBIDDEN` (collection readable) / `404 NOT_FOUND` (not readable, other tenant, forged tenant) | Nothing |

The response never claims more than is true: a new document is `pending`, and it is neither `ready` nor searchable until the worker has stored its chunks. The web role cannot write chunks at all (`replace_document_chunks` is not executable by `authenticated` since `20261120100002`).

## 5a. Custom agents

| Method & path | Body / query | Success | Who |
|---|---|---|---|
| `GET /api/v1/agents` | none | `200 {agents: CustomAgent[]}` (own private + organization agents, newest first) | members, viewers |
| `POST /api/v1/agents` | `{name ≤80, instructions 1..8000, description? ≤280, modelKey?, visibility?: private\|organization, tools?: [{capability, provider}], starters? ≤4×200, collectionIds? ≤10}` | `201 {agent}` | private: members; organization: owner/admin |
| `GET /api/v1/agents/{id}` | none | `200 {agent}` | readers |
| `PATCH /api/v1/agents/{id}` | any subset of the POST fields; the whole `CustomAgent` may be echoed back (read-only `id`, `ownedByMe`, `canEdit`, `canDelete`, `version`, `createdAt`, `updatedAt` are ignored; an echoed `id` must match the path) | `200 {agent}` | **owner only** (C-1). Everyone else, org admins included, gets `404` |
| `DELETE /api/v1/agents/{id}` | none | `200 {deleted:true}`; threads stay, with `agent_id` set to NULL | owner, or org owner/admin for organization agents (`canDelete`). Readers 403 |
| `GET\|POST /api/v1/agents/{id}/collections` | POST `{collectionId}` | `200 {collections}` / `201 {linked:true}` | GET: readers (readable collections only). POST: **owner only** (else 403); the collection must be readable (else 404); ≤10 visible links (`400 LIMIT_EXCEEDED`), enforced under a row lock (`link_custom_agent_collection`, `20261120100009`) so parallel requests cannot exceed it; linking an already linked collection is a `201` no-op |
| `DELETE /api/v1/agents/{id}/collections/{collectionId}` | none | `200 {deleted:true}` | owner only (else 403); a link to a collection the owner cannot read is invisible to them: `404`, and it stays |
| `POST /api/v1/agents/{id}/run` | `{content ≤8000, threadId?, modelKey?, timeZone?}` | `200` NDJSON stream (below) | readers of the agent |
| `POST /api/v1/chat/threads` | `{modelKey?, agentId?}` | `201 {thread:{id, title, modelKey, updatedAt, agentId}}` | with `agentId`: readers of the agent (`404 "Agent not found"` otherwise) |

`CustomAgent` (C-1 shape): `{id, name, description, instructions, modelKey, visibility, tools, starters, collectionIds,
ownedByMe, canEdit, canDelete, version, createdAt, updatedAt}`. `canEdit`, `canDelete`, `version` and `tools` are
additive to C-1. `conversationStarters` was renamed to `starters` (the old name is rejected; the API was unreleased).

- **Saving is one atomic statement** (`save_custom_agent`, migration `20261120100008`, SECURITY INVOKER): fields and
  `collectionIds` change together or not at all. `collectionIds` *replaces* the links the caller can see; links to
  collections the caller cannot read (the owner linked a shared collection that was later made private) are invisible
  to them and kept. Every id must be readable
  by the caller (`400 INVALID_COLLECTION` otherwise: unknown, foreign or unreadable all look the same). The database
  still caps an agent at 20 links in total, hidden ones included (`400 LIMIT_EXCEEDED`).
- **Errors:** `400 INVALID_REQUEST` (shape, length, unknown keys), `400 LIMIT_EXCEEDED` (>4 starters, >10
  collections), `400 INVALID_COLLECTION`, `400 INVALID_MODEL` (bad key or not in the catalogue; an unchanged stored
  key that has since left the catalogue is accepted so the builder can still save), `403`/`404` as above.
- **Editing is owner-only in the database too** (`20261120100009`): before it, RLS let org owners/admins update any
  organization agent and add or remove its links when calling PostgREST directly, although the API never allowed it.
  Now `custom_agents` UPDATE and link INSERT/DELETE require `private.can_edit_agent` (owner, org member, not a viewer).
  DELETE of an agent stays owner-or-admin (moderation). Links an admin added before this migration are kept.
- **`version`** counts changes to the agent's own fields (trigger from `20261120100004`). A save that only changes
  `collectionIds` does not bump it.
- **Instructions are returned to the owner only**; everyone else gets `instructions: ""` (a string, so typed clients
  need no null case), and organization agents can be used without exposing their prompt.
- **Chat threads with an agent:** `POST /chat/threads {agentId}` uses the agent's model when it is in the catalogue,
  else `modelKey` (`400 "Unknown model"` without one). `POST /chat/threads/{id}/messages` on such a thread runs the
  agent turn (same events as `/run`, below): agent instructions, tools (merged with `mentions`), knowledge as the
  caller, the agent's model (falling back to the chat's `modelKey` if it was retired), and the `agent.run` rate limit.
  Errors there use the chat client's human-readable `error` text, e.g. `409 "This agent is no longer available to
  you"` when the caller can no longer read the agent. Archived threads `404`; once the agent is deleted the thread
  continues as plain chat.
- **Run = the normal chat runtime.** Same model registry and endpoints, same `runTurn`, same tool registry,
  approval flow and message store. Model: `modelKey`, else the agent's model, else the first configured one
  (`400 UNKNOWN_MODEL` / `409 AGENT_MODEL_UNAVAILABLE`). Without `threadId` a thread with `agent_id` is
  created; with one, it must be the caller's own, unarchived thread **for this agent**
  (`409 THREAD_AGENT_MISMATCH` otherwise, 404 if not yours). The last 30 messages are sent as history.
- **Nothing widens access.** Tools are the agent's list **intersected with the caller's** connected
  capabilities; the rest are reported in `unavailableTools` with a reason (`not_available`, a connection
  state, `not_available_in_chat`, `model_without_tools`). Knowledge is searched **as the caller**: an
  organization agent linked to its author's private collection returns no excerpts from it for anyone else.
- **Prompt layout:** platform system prompt first, then "platform rules take precedence", then
  `<agent_instructions>`, then excerpts fenced in `<knowledge><excerpt n title>` and explicitly marked as
  untrusted reference data. Excerpt text and titles are stripped of the fence tags.
- **Retrieval query:** the message is reduced to up to 12 significant terms (EN/DE stopwords removed,
  letters/digits only, so no search operators can be injected), OR-ed together for full-text; the original
  message is what gets embedded. Up to 6 excerpts. If retrieval fails the turn still runs, with
  `knowledgeUnavailable: true`.
- **Stream events** (one JSON object per line): `agent` `{agent:{id,name,version}, thread, unavailableTools}`,
  `user` `{message}`, `citations` `{citations:[{n, documentId, collectionId, fileId, title, ordinal, snippet}],
  knowledgeUnavailable}`, then the chat runtime's `delta` / `tool_start` / `tool_result` /
  `approval_required`, and finally `done` `{message}` or `error` `{code, message?}` (e.g. `MODEL_UNAVAILABLE`;
  the assistant message is stored with `status: 'error'`).

## 5b. Rate limits

Per user and organization, fixed windows, enforced in Postgres (`consume_workspace_rate_limit`, which also
refuses non-members). Exceeding one returns **`429 RATE_LIMITED`** with a `Retry-After` header and
`retryAfterSeconds` in the body.

| Action | Limit | Applies to |
|---|---|---|
| `file.upload` | 60 / hour | `POST /files` (checked before the body is read) |
| `library.search` | 120 / minute | `GET /library/search` |
| `document.reindex` | 60 / hour | adding a document **and** reindexing (both enqueue work) |
| `agent.run` | 30 / minute | `POST /agents/{id}/run` (counted before the agent is loaded) |
| `agent.write` | 60 / hour | agent create/update/delete and collection links |

## 5c. Storage maintenance (worker `start:workspace-maintenance`)

- **Blob deletions** are queued in the database when files are deleted and drained by the worker with retries,
  so a storage outage never leaves orphaned rows or silently lost deletes.
- **Stale uploads** (row reserved but bytes never committed) are removed after `TUGPT_STALE_UPLOAD_MINUTES`.
- **Orphan sweep:** blobs with no file row, older than `TUGPT_BLOB_SWEEP_GRACE_HOURS`, are reported, and only
  deleted when `TUGPT_BLOB_SWEEP_DELETE=true`.
- **Organization deletion:** when `TUGPT_ORG_PURGE_ENABLED=true`, organizations deleted longer than
  `TUGPT_ORG_PURGE_GRACE_DAYS` ago have their workspace data (files, blobs, library, agents) purged via
  `purge_organization_workspace` (service role only, audited). Chat threads are not purged by this job yet.

## 6. Audit

Sensitive operations write to `public.audit_logs` (immutable) through `private.workspace_audit`:
`workspace.conversation.{renamed,archived,restored,moved,deleted}`, `workspace.folder.{created,deleted}`,
`workspace.approval.{requested,approved,rejected,cancelled,revoked}`, `workspace.file.{uploaded,deleted}`,
`workspace.attachment.{added,removed}`, `workspace.collection.{created,visibility_changed,deleted}`,
`workspace.document.{added,removed,reindex_requested}`, `workspace.thread_collection.{linked,unlinked}`,
`workspace.agent.{created,updated,deleted,collection_linked,collection_unlinked}` and
`workspace.organization.purged` (maintenance worker).
Details hold IDs, hashes and classes only: no arguments, file content, filenames of other users or storage keys.

## 7. Error codes

| Status | Codes |
|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_FILENAME`, `INVALID_SCOPE`, `INVALID_STATUS`, `INVALID_THREAD`, `INVALID_ENDPOINT`, `INVALID_CAPABILITY`, `INVALID_ARGUMENTS_HASH`, `INVALID_PREVIEW`, `INVALID_REASON`, `INVALID_DECISION`, `INVALID_NOTE`, `INVALID_TTL`, `QUERY_REQUIRED`, `QUERY_TOO_LONG`, `TOO_MANY_COLLECTIONS`, `INVALID_REQUESTER`, `INVALID_EMBEDDING`, `INVALID_ACTION`, `MESSAGE_INVALID`, `UNKNOWN_MODEL` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `INVALID_ORIGIN` |
| 404 | `NOT_FOUND` |
| 409 | `ALREADY_EXISTS`, `CONFLICT`, `ALREADY_DECIDED`, `REQUEST_EXPIRED`, `INVALID_STATUS_TRANSITION`, `FILE_CONTENT_IMMUTABLE`, `AGENT_MODEL_UNAVAILABLE`, `AGENT_TOOL_CONFLICT`, `THREAD_AGENT_MISMATCH` |
| 413 | `PAYLOAD_TOO_LARGE`, `ARGUMENTS_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `MEDIA_TYPE_MISMATCH` |
| 429 | `RATE_LIMITED` (with `Retry-After`), `LIMIT_EXCEEDED`, `TOO_MANY_PENDING`, `TOO_MANY_CHUNKS` |
| 503 | `STORE_UNAVAILABLE`, `STORAGE_NOT_CONFIGURED`, `STORAGE_UNAVAILABLE`, `INTEGRITY_CHECK_FAILED` |

## 8. Configuration (server-only environment)

| Variable | Meaning |
|---|---|
| `TUGPT_FILE_STORAGE` | `fs` or `s3`. **If unset, uploads and downloads fail closed** with `503 STORAGE_NOT_CONFIGURED`. |
| `TUGPT_FILE_STORAGE_DIR` | `fs`: an absolute directory. Files are written `0600` and directories `0700`; writes are atomic (tmp file, then rename). |
| `TUGPT_S3_ENDPOINT`, `TUGPT_S3_BUCKET`, `TUGPT_S3_REGION`, `TUGPT_S3_ACCESS_KEY_ID`, `TUGPT_S3_SECRET_ACCESS_KEY` | `s3`: any S3-compatible store (SigV4, path-style). The endpoint must be HTTPS with no userinfo, and redirects are refused. Load the credentials from the secret store, never from the repo. |
| `TUGPT_FILE_MAX_BYTES` | Upload cap, default 26214400, clamped to 52428800. |
| `TUGPT_APP_ORIGIN` | The exact origin used for the mutation check. |
| `TUGPT_EMBEDDINGS_URL`, `TUGPT_EMBEDDINGS_MODEL`, `TUGPT_EMBEDDINGS_DIMS`, `TUGPT_EMBEDDINGS_API_KEY` | OpenAI-compatible `/embeddings` endpoint, used by the worker (documents) and the web app (queries). HTTPS, or http on loopback only. All three of URL/model/dims are required, otherwise search is keyword-only. The key comes from the secret store. |
| `TUGPT_STALE_UPLOAD_MINUTES`, `TUGPT_BLOB_SWEEP_GRACE_HOURS`, `TUGPT_BLOB_SWEEP_DELETE`, `TUGPT_ORG_PURGE_ENABLED`, `TUGPT_ORG_PURGE_GRACE_DAYS` | Maintenance worker (section 5c). Defaults 60 min, 24 h, `false`, `false`, 30 days. Destructive steps are opt-in. |

## 9. Migrations (forward-only, new IDs)

`20261119100001_workspace_conversations` · `…100002_workspace_approval_requests` · `…100003_workspace_files` ·
`…100004_workspace_library` (frozen), then `20261120100001_workspace_knowledge_vectors` ·
`…100002_workspace_document_jobs` · `…100003_workspace_rate_limits` · `…100004_workspace_custom_agents` ·
`…100005_workspace_storage_maintenance` · `…100006_workspace_document_dedupe` (one document per content per collection) ·
`…100008_workspace_agent_save` (atomic agent save) · `…100009_workspace_agent_owner_edit` (owner-only editing in the database, atomic single link). All are registered in `supabase/migrations/checksums.json`. Any
further change needs a **new** migration ID.

## 10. Tests

| Suite | Command | Notes |
|---|---|---|
| Unit | `pnpm --filter web test` (includes `workspace-data.test.ts`, `agents.test.ts`); `pnpm --filter @tugpt/workspace-core test`; `pnpm --filter worker test` | Hermetic. SigV4 AWS vectors, path traversal, validation, DOCX/XLSX/PDF extraction and zip bombs, embeddings client, worker retry/lease logic, maintenance, agent prompt fencing and retrieval query, CSRF and the client |
| pgTAP | `supabase/tests/database/workspace_{conversations,approval_requests,files,library,document_jobs,rate_limits,custom_agents,storage_maintenance}.test.sql` | RLS, grants, RPCs, job state machine, hybrid search isolation, cross-tenant rules, audit |
| Integration (real PostgREST and RLS) | see `apps/web/tests/workspace-it/README.md` | Skipped unless `WS_IT_POSTGREST_URL` is set. Disposable DB only. Runs the real knowledge worker as `service_role`, a loopback fake embeddings server (hashed trigrams) and a loopback fake LLM (SSE) |
