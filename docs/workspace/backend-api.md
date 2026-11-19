# Workspace backend API (conversations, approvals, files, library)

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
| `POST /api/v1/library/collections/{id}/documents` | `{fileId, title?}` | `201 {document}`, indexed in the same request | writers; the file must be readable. The same file twice returns 409 |
| `POST /api/v1/library/collections/{id}/documents/{docId}` | none | `200 {document}` (re-index) | writers |
| `DELETE /api/v1/library/collections/{id}/documents/{docId}` | none | `200 {deleted:true}` (the file is kept) | writers |
| `GET /api/v1/library/search` | `q` (required, ≤200), `collectionIds=a,b` (optional), `limit` ≤50 | `200 {hits: SearchHit[]}` | readers |
| `GET\|POST /api/v1/chat/threads/{id}/collections` | POST `{collectionId}` | `200 {collections}` / `201 {linked:true}` | thread owner; the collection must be readable |
| `DELETE /api/v1/chat/threads/{id}/collections/{collectionId}` | none | `200 {deleted:true}` | thread owner |

- **Read/write rules:** private collections belong to their owner only; the org owner can't see them
  either. Organization collections are readable by every member, including viewers, and writable by
  admins and the creator.
- **Indexing:** txt, md, csv, json and log, plus **DOCX** (its own bounded ZIP reader; tracked deletions and
  field codes are dropped; 20 MB XML cap against zip bombs). Text is split into chunks of about 1,500
  characters with 150 characters of overlap, at most 2,000 chunks. A document ends in `ready`, or in
  `failed`/`unsupported` with an `errorCode`. **PDFs return `unsupported` with `PDF_EXTRACTION_UNAVAILABLE`.**
- **Search:** Postgres full-text search (the `simple` config, so it works across languages) with `ts_rank`. Snippets are plain text.
  Results are filtered by RLS on every query, so a hit is never returned from a collection you can't read.

## 6. Audit

Sensitive operations write to `public.audit_logs` (immutable) through `private.workspace_audit`:
`workspace.conversation.{renamed,archived,restored,moved,deleted}`, `workspace.folder.{created,deleted}`,
`workspace.approval.{requested,approved,rejected,cancelled,revoked}`, `workspace.file.{uploaded,deleted}`,
`workspace.attachment.{added,removed}`, `workspace.collection.{created,visibility_changed,deleted}`,
`workspace.document.{added,removed}` and `workspace.thread_collection.{linked,unlinked}`.
Details hold IDs, hashes and classes only: no arguments, file content, filenames of other users or storage keys.

## 7. Error codes

| Status | Codes |
|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_FILENAME`, `INVALID_SCOPE`, `INVALID_STATUS`, `INVALID_THREAD`, `INVALID_ENDPOINT`, `INVALID_CAPABILITY`, `INVALID_ARGUMENTS_HASH`, `INVALID_PREVIEW`, `INVALID_REASON`, `INVALID_DECISION`, `INVALID_NOTE`, `INVALID_TTL`, `QUERY_REQUIRED`, `QUERY_TOO_LONG`, `TOO_MANY_COLLECTIONS`, `INVALID_REQUESTER` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `INVALID_ORIGIN` |
| 404 | `NOT_FOUND` |
| 409 | `ALREADY_EXISTS`, `CONFLICT`, `ALREADY_DECIDED`, `REQUEST_EXPIRED`, `INVALID_STATUS_TRANSITION`, `FILE_CONTENT_IMMUTABLE` |
| 413 | `PAYLOAD_TOO_LARGE`, `ARGUMENTS_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `MEDIA_TYPE_MISMATCH` |
| 429 | `LIMIT_EXCEEDED`, `TOO_MANY_PENDING`, `TOO_MANY_CHUNKS` |
| 503 | `STORE_UNAVAILABLE`, `STORAGE_NOT_CONFIGURED`, `STORAGE_UNAVAILABLE`, `INTEGRITY_CHECK_FAILED` |

## 8. Configuration (server-only environment)

| Variable | Meaning |
|---|---|
| `TUGPT_FILE_STORAGE` | `fs` or `s3`. **If unset, uploads and downloads fail closed** with `503 STORAGE_NOT_CONFIGURED`. |
| `TUGPT_FILE_STORAGE_DIR` | `fs`: an absolute directory. Files are written `0600` and directories `0700`; writes are atomic (tmp file, then rename). |
| `TUGPT_S3_ENDPOINT`, `TUGPT_S3_BUCKET`, `TUGPT_S3_REGION`, `TUGPT_S3_ACCESS_KEY_ID`, `TUGPT_S3_SECRET_ACCESS_KEY` | `s3`: any S3-compatible store (SigV4, path-style). The endpoint must be HTTPS with no userinfo, and redirects are refused. Load the credentials from the secret store, never from the repo. |
| `TUGPT_FILE_MAX_BYTES` | Upload cap, default 26214400, clamped to 52428800. |
| `TUGPT_APP_ORIGIN` | The exact origin used for the mutation check. |

## 9. Migrations (forward-only, new IDs)

`20261119100001_workspace_conversations` · `…100002_workspace_approval_requests` · `…100003_workspace_files` ·
`…100004_workspace_library`. All four are registered in `supabase/migrations/checksums.json`. Any further
change needs a **new** migration ID.

## 10. Tests

| Suite | Command | Notes |
|---|---|---|
| Unit | `pnpm --filter web test` (includes `workspace-data.test.ts`) | Hermetic. Covers the SigV4 AWS vectors, path traversal, validation, DOCX and zip bombs, redaction, CSRF and the client |
| pgTAP | `supabase/tests/database/workspace_{conversations,approval_requests,files,library}.test.sql` | RLS, grants, RPCs, state machine, cross-tenant rules, audit |
| Integration (real PostgREST and RLS) | see `apps/web/tests/workspace-it/README.md` | Skipped unless `WS_IT_POSTGREST_URL` is set. Disposable DB only |
