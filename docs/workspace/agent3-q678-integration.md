# Agent 3 Q678 frontend integration

## Revision and isolation

Branch: `integration/agent3-q678-frontend`.
Worktree: `/srv/tugpt-workspace/ws-agent3-q678`.
Backend base: `514e4289096cd7a8c79d2c5c75b65aec0ca4d48d` (Agent 4 combined Q678).
Frontend overlay commit: `f56d31e91768d1d990ae3d70ca93e8cd9707dce5` (97 files).
This document accompanies the subsequent contract integration commit; obtain its exact SHA with `git log -1 --format=%H -- docs/workspace/agent3-q678-integration.md`.
No merge, push, deployment, production/shared-preview change or Agent 4 worktree modification was performed.

## Integrated behavior

- CustomAgent and Citation response types are imported from the backend contract rather than duplicated.
- Seven editable fields remain whitelisted at both cleanAgent and the transport boundary: name, description, instructions, modelKey, starters, collectionIds, visibility. Omission/null/empty-array regression tests are retained. Response-only permissions, version and tools are never serialized.
- Server session role and resource hints jointly control actions. Writer roles may create; edit requires ownedByMe and canEdit; delete requires canDelete, including non-owner admin deletion. Missing/unknown role fails closed. Organization sharing is restricted to owner/admin.
- Dedicated knowledge dialog uses real collection subresources, accepts 201/200 link successes and 200 unlink, preserves checked state on 403/404/LIMIT_EXCEEDED, and never automatically replays writes. Inline builder collectionIds remain supported.
- Document registration retains 202 created:true and 200 created:false handling, canonical title/status, row reconciliation, and explicit reused-document notice.
- Recent, search and archive lists drain paginated responses through the same helper. Each opaque nextCursor is passed unchanged as before. Duplicate rows are reconciled by ID; repeated cursors and malformed pages fail rather than loop. This currently fetches all matching pages, not an incremental Load More UI.
- Agent start links use a query selection, resolved through authorized GET /agents/:id before creation. Thread POST includes agentId only after resolution and only behind the release gate. Inaccessible agents never silently fall back to ordinary new chat.
- NDJSON agent and citations events are validated; sources render as escaped text on the final message. Unavailable knowledge/tools are explained. Existing approval_required, done, error and cutoff behavior is retained. String terminal error messages are not mistaken for stored chat messages. Events from aborted streams are ignored.
- Existing TuGPT styles, branding, navigation and identity UI were preserved, not redesigned.

## Release blockers / Agent 4 handoff

`agentsApiAvailable` remains **false**. The handoff file's suggestion to enable it does not satisfy the user's real-route and end-to-end verification prerequisite.

1. `apps/web/src/lib/chat/store.ts`: ThreadSummary, THREAD_COLS and toThread omit agentId. GET /chat/threads/:id uses this path, while POST thread creation returns agentId. Conversation list also omits it. A reload therefore cannot restore the custom-agent identity before the next agent event. Request an explicit authorized agentId (including null for plain/deleted bindings) in the saved-thread response and document its behavior. Frontend does not guess it from URL/local state; when the gate is enabled in tests, saved chats are labeled as server-determined until the agent stream identifies them.
2. StoredMessage and the restored-message response contain no citation metadata. Current source displays are transient frontend metadata, not persistent history. Decide/document whether restored citations are required and provide a backend contract if so.
3. Authenticated real CRUD/role, collection, agent-run/approval, reload and tenant-isolation acceptance on this exact combined revision remains outstanding. The 46 opt-in backend route tests were skipped; no production/shared preview was touched to obtain acceptance.
4. Frontend retry and reused-document tests are NOT proof of backend content-hash deduplication. No new live dedup acceptance is claimed.

No backend source or migration was changed to conceal these gaps. Existing built-in chat remains available. The gate is not to be enabled solely because mocked frontend tests pass.

## Verification

Evidence directory: `/srv/tugpt-workspace/ws-agent3-q678-evidence`.

- `pnpm build`: passed (15/15 tasks), build-final.log.
- `pnpm exec turbo lint typecheck test`: passed (57/57 tasks), gates-final.log.
- Full tests: 2,657 passed; 46 opt-in backend integration tests skipped. Web: 1,308 passed / 46 skipped.
- Focused Workspace/chat/stream suite: 201 passed / 46 skipped, focused-final.log. Includes retained upload regressions and 37 new contract/UI checks.
- Lint: zero errors, six pre-existing web warnings in MCP snapshot route, Google OAuth test, HTTP mutations and WhatsApp secrets.
- First full attempt had one DraftReviewUi permission-error assertion timeout/failure. Isolated rerun passed 19/19; both subsequent full runs passed. No unrelated Draft Review code/test edits were made.
- Fresh authenticated browser/mobile visual acceptance was not run for this revision. Earlier accepted 87/87 evidence belongs to 8b8eb7e, not this new integration.
- Prior heads remain unchanged and clean: original 9080995c91efd89b4c5d9cb0d57d59190729fe2f; accepted 8b8eb7ec706ba2dc9732cca1960a8d0bb44c5596; follow-up and staging 3b9d54e5687ffd787e5c6de5801f46fbdca140f1.
- Accepted ZIP SHA256 unchanged: d82d8f20382498d174347871dc9f0ec6c69ae0a14e919d6d6a5906471565ac93.

## Contract-integration file manifest (after overlay)

- `apps/web/src/app/(workspace)/workspace/agents/page.tsx`
- `apps/web/src/components/chat/AgentChatContract.test.tsx`
- `apps/web/src/components/chat/AgentMenu.tsx`
- `apps/web/src/components/chat/ChatView.tsx`
- `apps/web/src/components/chat/Composer.tsx`
- `apps/web/src/components/chat/Conversation.tsx`
- `apps/web/src/components/chat/types.ts`
- `apps/web/src/components/chat/useChatSession.ts`
- `apps/web/src/components/workspace/AgentCollectionsDialog.tsx`
- `apps/web/src/components/workspace/AgentsView.tsx`
- `apps/web/src/components/workspace/ThreadsProvider.tsx`
- `apps/web/src/components/workspace/__tests__/AgentCollectionsContract.test.tsx`
- `apps/web/src/components/workspace/__tests__/AgentPermissionsContract.test.tsx`
- `apps/web/src/components/workspace/__tests__/ThreadManagement.test.tsx`
- `apps/web/src/i18n/en.ts`
- `apps/web/src/i18n/es.ts`
- `apps/web/src/lib/chat/stream.ts`
- `apps/web/src/lib/workspace/agent-events.ts`
- `apps/web/src/lib/workspace/agent-permissions.ts`
- `apps/web/src/lib/workspace/agents.ts`
- `apps/web/src/lib/workspace/conversation-pages.ts`
- `apps/web/src/lib/workspace/custom-agents.ts`
- `apps/web/src/lib/workspace/q678-contract.test.ts`
- `apps/web/src/lib/workspace/service.ts`
- `docs/workspace/api-contracts.md`
- `docs/workspace/agent3-q678-integration.md` (this handoff)
