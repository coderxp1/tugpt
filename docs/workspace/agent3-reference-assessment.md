# Workspace reference assessment

## Decision
Selectively adapt interaction ideas, not the reference application. TuGPT's branding, typography, navigation, responsive shell and Dashboard/Workspace boundary remain unchanged. No reference dependencies, theme or components were copied wholesale.

Source root reviewed: `/srv/tugpt-workspace/tugpt-full-project/tugpt/app/src`. The examined Workspace pages use mockData and local React state; no fetch/axios/createClient/localStorage calls were found in the Workspace pages or sidebar. This is a UI prototype, not evidence of working integrations or persistence. Unrelated transcripts and credentials were not used.

| Reference source | Useful pattern and TuGPT destination | Decision and API dependency |
| --- | --- | --- |
| `app/workspace/chat/page.tsx`, lines 29–117, 143, 321, 364, 458–478 | Conversation filtering, attachment chips and per-answer actions → existing ChatView and chat session | Preserve existing real implementations. Reject timer-generated answers, fabricated citations/compliance, hardcoded attachments and raw provider model labels. Real thread/message and file APIs remain authoritative. New cross-tab recovery is TuGPT-specific, not copied from this reference. |
| `app/workspace/agents/page.tsx`, lines 20–73, 138–201 | Clear configuration/test workflow → AgentsView | Add searchable knowledge selection without losing hidden selections; save through the actual agents API. Search is a TuGPT enhancement, not an existing reference feature. Reject local-only agent creation, nonfunctional Save Changes, fixed test responses and misleading isolated-preview claims. Testing uses saved-agent chat, not a fictional preview endpoint. |
| `app/workspace/documents/page.tsx`, lines 32–44, 239–264 | Typed document metadata → FileManager | Add explicitly current-page file-type narrowing using actual file-list metadata. The reference's document cards do not provide this functional filter. Reject fabricated OCR/indexing/retention statuses and decorative upload functionality. Stored, previewable, indexed and AI-readable remain separate concepts. |
| `components/WorkspaceSidebar.tsx`, lines 43–129; `app/workspace/layout.tsx`, lines 22–63 | Grouped navigation and mobile containment → existing Workspace shell | Retain TuGPT shell and focus behavior; no theme replacement. Reject fake organization switching and hardcoded model/integration counts. Administration stays in Dashboard. |
| `app/workspace/members/page.tsx`, lines 15–45, 115–119 | Explicit role presentation → Collections/FileManager | Enforce organization-collection read-only UI for manager/agent/viewer, including owned collections, consistent with backend contract. Reference invitations are local-state only and are not adopted. Real authorization remains server-owned. |

## Recovery and preview boundaries
- Persistent recovery contains correlation metadata only. Prompt/partial text remains tab-local; authenticated reads determine whether the exact observed user message has a completed answer. Unknown/empty reads never authorize automatic replay.
- Web Locks prevent competing sends in supported browsers. Without Web Locks, the marker check is not atomic. This is same-browser recovery, not cross-device concurrency control. Browser-reopen persistence is designed but a full browser-process restart was not browser-tested; closing the original tab and recovering in a fresh tab was tested.
- Losing the stream before observing the server message ID can remain unresolved. Durable turn lookup/leases require Agent 4's approved, integrated backend contract; Q14 is local-only and not enabled here.
- Existing safe bounded text/raster previews and upload recovery are retained, not newly replaced. PDF/Office preview remains unavailable; Q14's bounded indexed-text preview is a proposal, not an implemented endpoint. No inline same-origin PDF or speculative API was added.
- Completed-answer regeneration and atomic document moves remain unavailable. Raw modelKey remains a network dependency pending an opaque capability catalogue.
- Agent 5 owns real-provider, cross-tenant and release/staging acceptance. Current evidence uses real disposable API/storage/RLS/indexing with simulated session/model behavior; it is not production or cross-tenant certification.

## Validation
1,467 tests passed; 52 integration tests skipped. Typecheck, changed-component lint and production build passed. Fresh browser runs: 48 recovery/filter assertions plus 33 organization-permission assertions, at 360, 390, 768 and 1440 px. Positive mixed file-type cases are unit-tested; browser image exclusion may encounter an empty matching set. No production deployment, backend migration, merge or rebase performed.
