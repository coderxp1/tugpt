# Workspace files, previews and builder increment

Base: 95e2cde. Frontend only; no production/deployment/integration changes.

## Delivered
- Wider image dialog, full-width images instead of thumbnail-sized tall images, zoom/fit-width controls, scrollable keyboard-focusable image area and sticky close/header.
- Unsupported formats/sizes now have an explicit preview state and authenticated download fallback. No PDF/Office browser embedding or third-party viewer.
- Files upload uses actual XHR byte progress. 100% transfer is distinct from server-confirmed storage. Success explicitly says not yet indexed.
- Owned-file reconciliation checks filename, size, SHA-256 and visibility across paginated results before upload. An existing match is reused.
- Ambiguous outcomes retain a hashed, user/organization/visibility-scoped local browser marker across refresh. Unresolved uploads cannot be blindly retried. Web Locks coordinate same-file attempts in the same browser. Missing browser storage/locks fails closed. No file contents, filename, credentials or provider details are persisted in the marker.
- Collection uploads use the same coordinator and progress transport, preserving collection visibility. Existing owned documents can be reused without consuming another upload request. Adding documents still uses the real API and backend indexing status.
- Agent builder prevents duplicate in-flight submissions, keeps the dialog open during saving, and blocks saving unavailable selected capabilities without inventing a fallback.

## Browser evidence at 360, 390, 768, 1440 px
- Preview: 32/32 assertions (real upload/read/delete, second-user denial, zoom/fit/overflow, injected preview-GET failure).
- Upload/recovery: 24/24 (real network-throttled upload progress, real saved file with deliberately lost response, refresh reconciliation without another POST, unresolved/no-match block, injected definite rejection followed by explicit successful retry, isolation).
- Main knowledge/agent/chat/citation/reopen journey: 67 assertions at each width, 268 total. The final desktop run reused an already-stored matching text file through the new collection coordinator; it did not create another binary copy. Fresh upload was separately verified at all widths.
- Conversation and agent lifecycle: 12/12 at 360, 390 and 768. Desktop: 8 conversation assertions passed, then real API 429 blocked agent editing and the four remaining assertions. This is NOT a fully passing desktop lifecycle run. No limiter reset or alternate identity used to evade it.
- Interrupted chat response: 12/12 across the four widths, saved answer and citation reconciled with exactly one prompt POST.
- 380 passing assertions recorded, with the desktop lifecycle block above. Earlier desktop upload attempt also hit a real 429; that log is preserved. No assertion-count-only claim of complete acceptance.
- Preview/upload runs preceded the final visibility-aware collection-coordinator extension; the final desktop journey exercises that extension. Three smaller-width main/lifecycle runs predate that extension; no claim that every script ran against the identical final source tree.

## Automated checks
Final full web suite: 1439 passed, 52 integration tests skipped. Production build, typecheck and changed-component lint pass. UI collection tests mock the upload coordinator; coordinator transport/recovery has dedicated tests and browser evidence.

## Environment and remaining work
Real local API, database/RLS, storage, keyword indexing/retrieval/citations. Model remains explicitly simulated; synthetic sessions, not real SSO. Loss/rejection injections are labeled above. Agent 5 reports real-model availability separately; this checkpoint is not integrated into that environment.
Frontend work remains: composer binary-upload path has not adopted this upload coordinator; upload rate-limit countdown/Retry-After presentation, finer collection mutation role controls and document moving, more complete attachment/conversation management, and richer supported document previews. No claim of daily-use product completion or universal duplicate prevention across devices/storage clearing.
Backend needs: idempotent upload IDs plus authoritative status/settlement to safely recover no-match uncertainty across devices; authorized extracted-text/rendered-page preview metadata and endpoints for PDF/Office; positive deployed turn-storage capability before Q12 retries; concurrency-safe retries and long-thread lookup; opaque capability IDs/availability metadata and safe error codes.
Agent 5: compatible integrated test entry point for this frontend/Q12/real model, shared staging/real SSO only after user authorization. No production changes authorized.

## Reproduction
Use existing isolated HTTPS frontend and synthetic browser fixtures; never package cookies. Build with the existing staging/Workspace-agents flags. Run upload-preview-browser.cjs and upload-recovery-browser.cjs, then capability-browser.cjs and capability-lifecycle.cjs with WIDTH and separate EVIDENCE_DIR per width. Run upload-chat-recovery.cjs with EVIDENCE_DIR pointing to a successful main journey's IDs. Respect real API Retry-After/rate limits; do not clear them. The archive includes the scripts and a preview fixture; set PREVIEW_FIXTURE to its absolute path for the preview runner. Scripts need the existing Playwright/Chromium paths and isolated environment listed in the earlier handoffs.
