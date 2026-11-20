# Workspace daily-use frontend increment

Branch: feat/agent3-workspace-daily-use. Based on accepted mobile identity commit bb341e33ecebedf966157e09c1628aafe6666a3d. Accepted identity component unchanged.

## Delivered
- Files section in Library: private/shared scope, paginated listing, explicit current-page filename filter, allowlisted private uploads up to the configured default 25 MB, indeterminate upload activity, stored/uploading/failed state, authenticated plain-text preview up to 1 MB, download, extension-preserving rename, owned-collection linking and confirmed deletion. English/Spanish copy. Existing shared dialogs and design system. Read-only viewer/unknown-role UI, owned-file controls, admin moderation for organization-visible files. API/RLS remains authoritative.
- Ambiguous chat failures (network, HTTP 5xx, missing terminal stream event, stop): never restore a resendable prompt automatically. Retain original prompt and unconfirmed partial text in the current view, block sending until explicit GET reconciliation, replace visible history/citations from the server. No POST on reconciliation. A synchronous send lock prevents rapid duplicate clicks, including while creating a conversation.
- Known rejected requests retain explicit draft retry (HTTP 429 demonstrated). This intentionally replaces the earlier assumption that every HTTP 503 can safely be replayed.
- Saved model no longer silently falls back when absent from the configured catalogue. User must choose an available model. Existing keyboard model selection, private/hosted metadata, descriptions and tool capability indicators retained and tested with two catalogue entries.

## Verification
373 browser assertions across repeated viewport runs: 66 main workflow plus 12 lifecycle checks at each of 1440, 768, 390 and 360 px; 48 file/recovery checks across those widths; 13 role/search/second-user checks. These are assertions, not 373 unique features. Main workflow includes normal chat, configured model, collection creation/upload/real indexing, agent creation/model/knowledge binding, retrieval/citations, continuation and navigation/reload. Lifecycle includes attachment, rejected-request retry, conversation rename/search/archive/restore/delete and agent edit/knowledge unlink/relink. Mobile checks operate the controls, not just layout assertions. These are Chromium viewport tests, not physical-device/virtual-keyboard certification.

Recovery browser scenario: real API completes and stores an answer; Playwright removes terminal stream events in transit. Explicit reconciliation retrieves saved messages/citations, with exactly one user message and one POST. This does not demonstrate regenerating an answer that the server never finished. Tests also cover network exceptions and HTTP 500 without replay. Current-view original/partial text is not claimed durable across reload; only server-saved content is durable.

New focused suite has file-role/confirmation and chat-reconciliation/unavailable-model coverage. Build succeeds. Final standard gate: 56/57 tasks, web#test failed on unchanged Dashboard localized error-banner assertion. Complete web suite with --maxWorkers=1: 113 test files passed, 1 skipped; 1,413 tests passed, 52 integration tests skipped. Lint and typecheck pass. Earlier 57/57 result predates the final original-message recovery disclosure; it is not represented as the final gate. Dashboard DraftReviewUi has intermittent unrelated assertion failures under the full run; failed logs retained, no Dashboard source changed to mask it. Existing six lint warnings remain.

## Reproduction
Existing isolated environment only; pre-existing synthetic sessions and deterministic simulated model, no new credentials. Frontend https://localhost:3619 is local review, not shared staging. Source worktree /srv/tugpt-workspace/ws-agent3-mobile; evidence /srv/tugpt-workspace/ws-agent3-daily-evidence. Server startup uses existing restricted run-web.sh (not bundled because it references server configuration). Build with NEXT_PUBLIC_TUGPT_DEPLOYMENT_TIER=staging NEXT_PUBLIC_TUGPT_WORKSPACE_AGENTS=true pnpm --filter web build.

From the worktree, with server ready:

```sh
node scripts/workspace-demo/daily-browser.cjs
node scripts/workspace-demo/daily-files-recovery.cjs
node scripts/workspace-demo/daily-lifecycle.cjs
node scripts/workspace-demo/daily-permissions.cjs
```

For each additional width, set WIDTH=360, WIDTH=390 or WIDTH=768 and EVIDENCE_DIR to its existing subdirectory; run daily-browser then daily-lifecycle. The first script creates resources; lifecycle deletes only its normal test conversation, so rerun browser before repeating lifecycle. Files/recovery creates and deletes only its new test files and appends turns to its test agent conversation. Permissions changes only disposable fixture membership and restores it. No secrets included in the bundle.

## Remaining frontend and dependency work
- Safe regeneration/resume requires backend turn identity, idempotency and settlement contract. Reconciliation is not regeneration and cannot establish the fate of an unacknowledged turn from a history snapshot alone. Approved tool-call recovery is not extended by this change.
- Durable draft recovery, comprehensive upload retry/reconciliation, file folders/global filename search, image/PDF/Office previews and format-by-format extraction acceptance remain open. Preview currently supports small plain-text-compatible files only. Storage allowlist is not a promise of extraction or model-readable context. Collections already expose processing/reindex states; broader failed-format acceptance remains needed.
- Multi-entry selector interaction is unit-tested. Browser catalogue still contains only Scout. Per-user allowed-model catalogue, availability metadata and provider-specific errors need the authoritative backend contract; real multi-provider switching remains unverified.
- Agent 4/5 dependencies posted in agent3-handoffs/daily-use-backend-dependencies.md. Shared staging/two-user login and approved real endpoint/model ID/server-side credentials have not been confirmed. External SSO and embeddings remain unverified. Simulated response labeling remains visible.
- No backend implementation, migrations, infrastructure provisioning, GitHub administration, push, merge or deployment performed. Accepted branches/evidence preserved.
