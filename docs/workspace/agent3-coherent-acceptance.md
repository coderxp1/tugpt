# Agent 3 coherent Workspace checkpoint

Scope: frontend-only, on feat/agent3-workspace-daily-use, after 6d3fcb2. No deployment, integration/rebase, backend/API/migration, or production changes.

## Implemented
- Agent save respects Retry-After seconds or HTTP dates. Draft retained, countdown, disabled Save, local write guard. Reads allowed; no automatic replay. Server remains authoritative across reloads.
- Composer shares Files/collections upload coordinator: byte progress, storage confirmation, explicit check/retry, durable pending fingerprint reconciliation after refresh/reselection. Route changes abort pending uploads and prevent linking to a different selected chat. Stored binaries are explicitly not claimed AI-readable.
- Destination-first document movement between owned collections of the same visibility. Confirm destination registration before removing source link; never delete binary. Not atomic. Ambiguous destination response preserves source; removal failure explains partial completion. New destination indexing is separate and earlier citations may become inaccessible.
- Collection mutation controls are role/ownership-aware; viewer/unknown are read-only. Organization publication restricted in UI to owner/admin (existing organization collection can remain organization-visible). Server authorization is still required.

## Verified
- Full web suite: 1446 passed, 52 skipped (environment-gated backend integration tests). A later default-concurrency rerun hit one existing DraftReviewUi timeout; unchanged tests passed on full rerun with --maxWorkers=2. Both logs are retained.
- Typecheck, changed-component lint, production build and diff whitespace check passed.
- 144 passing browser assertions: main journey 67, new coherent flows 30, interrupted-chat recovery 12, lifecycle 12, permissions 13, collection viewer permissions 9.
- 360, 390, 768, 1440 px: cooldown draft retention/no automatic write/explicit actual save; stored-upload response loss followed by refresh/reselection without duplicate binary; document move persisted using same file; viewer collection controls; cited chat identity/reopen/refresh; GET-only ambiguous-turn recovery.
- Desktop lifecycle: text attachment, explicitly rejected draft resend, rename/search/archive/restore/delete, agent instruction edit and knowledge unlink/relink.
- Real disposable APIs, database/RLS, blob storage and keyword indexing/retrieval/citations. Model and session identities are synthetic. Controlled 429 and lost-response failures are injected, not claimed spontaneous backend failures.
- Second-user same-organization denials verified. This is NOT cross-tenant acceptance.

## Reproduction
From /srv/tugpt-workspace/ws-agent3-mobile, with the existing isolated environment/session files prepared privately:

```sh
pnpm --filter web test
pnpm --filter web typecheck
NEXT_PUBLIC_TUGPT_DEPLOYMENT_TIER=staging NEXT_PUBLIC_TUGPT_WORKSPACE_AGENTS=true pnpm --filter web build
export EVIDENCE_DIR=/srv/tugpt-workspace/ws-agent3-coherent-evidence
WIDTH=360 node scripts/workspace-demo/capability-browser.cjs
node scripts/workspace-demo/coherent-browser.cjs
node scripts/workspace-demo/upload-chat-recovery.cjs
node scripts/workspace-demo/capability-permissions.cjs
WIDTH=1440 node scripts/workspace-demo/capability-lifecycle.cjs
node scripts/workspace-demo/collection-permissions.cjs
```

Run against only Agent 3's isolated frontend at https://localhost:3619. Main journey creates disposable fixtures; lifecycle deletes its normal test chat. Permission runners alter only disposable user's role and restore agent in finally. Do not reset quotas or automatically rerun on real 429. Browser scripts require the documented preinstalled Playwright/Chromium paths; credentials are not packaged.

## Remaining dependencies / limitations
- Agent 5 integrated real-model and two-organization browser acceptance; private test workflow/access requested in handoff. No claim that Agent 3 independently verified Agent 5's model.
- Q13 d50f471 is local-only/not deployed. Need positive runtime API/storage capability signal before enabling idempotent-turn/upload APIs. Generic 404 never authorizes prompt resend.
- Provider-neutral presentation is implemented; opaque capability identifiers and authoritative multi-capability availability catalogue remain backend dependencies. Legacy modelKey is still in network payloads. No real multi-model acceptance claimed.
- Upload markers are browser/owner/organization-scoped, not cross-device idempotency. After refresh, reselect the same file to reconcile; pending chips themselves are not restored automatically.
- Ambiguous chat recovery original/partial state is not fully durable across reload; completed-response regeneration is not implemented.
- Document movement is non-atomic and conservatively restricted to owned same-visibility collections. Backend-approved movement/role semantics requested from Agent 4.
- Complete integrated Workspace acceptance remains OPEN, not production-ready certification.
