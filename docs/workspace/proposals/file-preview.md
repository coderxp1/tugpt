# Request 5: authenticated PDF/Office preview (PROPOSAL, NOT IMPLEMENTED)

> **Status: awaiting the owner's scope decision. Do not implement.** `GET /api/v1/chat/features` reports
> `files.preview` as `unavailable`; the only file access is the download route (always `attachment`).

`files.preview` reports `unavailable` until shipped.
Today: `GET /api/v1/files/{id}/content` = RLS metadata read, ready-only, sha256 check, always `attachment`, nosniff, sandbox CSP.

## Options
| Option | What | Risk | Verdict |
|---|---|---|---|
| A. Serve the original `inline` on the app origin | browser PDF viewer / Office handler | active content (PDF JS, forms, links) on the session origin; MIME confusion | **Rejected** |
| B. Text preview from the index | JSON of the already-extracted, RLS-scoped text per page/slide (worker output) | no new parser, nothing rendered as HTML; no layout/images | **Phase 1 (recommended)** |
| C. Server-rendered page images | PDF→PNG (pdfium/poppler), Office→PDF→PNG (LibreOffice) in an isolated, no-network sandbox worker; derived blobs | parser attack surface, CPU/memory; needs container isolation review | Phase 2, only after security review |
| D. Inline original from a separate cookieless sandbox origin with short-lived signed URL | | new origin, URL leakage window | not proposed now |

## Phase 1 scope (B)
* Endpoint `GET /api/v1/files/{fileId}/preview?page=N` (session; proxy-protected; not under `/api/v1/workspace`).
* Formats: PDF (text layer), DOCX, PPTX (slides + notes), XLSX/CSV/TXT/MD as already indexed. Scanned PDFs: `PDF_NO_TEXT_LAYER`
  (no OCR). Images: `UNSUPPORTED_FOR_PREVIEW`.
* Response: `{fileId, mediaType, pages: [{n, kind: 'page'|'slide'|'sheet', text}], totalPages, truncated}`; plain text only,
  rendered by the client as text (never `innerHTML`). `Cache-Control: private, no-store`, nosniff.
* Limits: ≤ 20 pages per request, ≤ 200 000 characters per response, page cursor; per-user rate limit (existing limiter).
  No processing on request: only rows the worker already wrote.

## Authorization and isolation
* Access = the same check as download, evaluated on **every** request: caller can read the `workspace_files` row under RLS
  (owner, or visibility rule) in their organization. Preview via a collection does **not** widen access: a member who can
  search an org collection but cannot download the private file gets 404 for preview too (matches D4 today).
* Tenant: organization_id from the session tenant; RLS on files + chunks; no service role in the request path.
* After a permission change (file made private, deleted, membership removed, collection made private) the next request is
  refused (404) because nothing is cached server-side or in shared caches; responses are no-store.
* Audit: optional `file.previewed` event (decision for owner: volume vs. value).

## Acceptance tests (before enabling)
Owner 200; colleague on private file 404; other tenant 404; anonymous 401; member via org collection but private file 404;
revocation (private → 404 on next call); deleted file 404; size/page limits; scanned PDF code; XSS payload text returned
verbatim as JSON string; pgTAP for any new RPC; HTTP E2E on real stack.

## Open decisions for the owner
1. Approve Phase 1 (text preview) as the only scope now? 2. Audit preview events? 3. Phase 2 (images) needs an isolated
rendering container design + security review; not started.

## Fixed constraints (keep even if the scope changes)
* **Never serve originals inline** on the application origin (option A is rejected, not deferred).
* Limits: **≤ 20 pages** and **≤ 200 000 characters** per response.
* Access is re-checked on every request with the download rule; preview never widens access (collection search ≠ file read).
