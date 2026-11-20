# File previews and folder acceptance

Frontend-only increment over 3bc4db8, local branch feat/agent3-workspace-daily-use.

## Usable changes
- Authenticated PNG/JPEG/GIF/WebP previews up to 8 MB, alongside escaped text previews up to 1 MB.
- Loading, download fallback and explicit GET-only retry on preview errors.
- Preview response byte limits; request abort and object URL cleanup on close. HTML/SVG/Office/PDF are never embedded as active previews.
- Explicit distinction between previewing/storing a file and indexing it for the assistant.
- English/Spanish handling for backend PDF_NO_TEXT_LAYER and UNSUPPORTED_FOR_INDEXING errors. These mappings do not imply the old local backend gained new extraction capabilities.

## Verification
- Production build, TypeScript check, changed-component lint pass.
- 26 focused component tests pass (11 preview, 7 file management, 8 thread management).
- Image preview browser checks: 24/24 across 360, 390, 768, 1440 px. Real upload/storage/read/delete and second-user denial. Only the initial failed preview GET is injected; retry reaches the real API.
- Existing folder workflows: 24/24 at the same widths: create, move, refresh, rename, second-user list isolation, delete folder while preserving its conversation. No new folder functionality claimed. First runner attempt checked visibility before hydration; adding a locator wait fixed the runner, not application code.
- Main journey rerun at all four widths; agent editing/conversation lifecycle rerun at all four widths; file/recovery rerun at all four widths; role checks rerun. Individual JSON results are the authoritative assertion counts.
- New preview screenshots captured again after the final loading-state lint fix and rebuild. The previewed image is an older Workspace screenshot uploaded as an ordinary private test file, not a mock of the current UI.

## Real / simulated / pending
Real: local APIs, RLS, blob storage, keyword indexing, retrieval/citations, file management, folders. Synthetic test sessions, not real SSO. The model remains explicitly simulated in Agent 3's local environment. Transport loss and preview 503 are controlled browser injections.
Agent 5 reports a real model on its integrated loopback app; this branch has not been tested with that model. Shared staging and real two-user SSO remain blocked on authorization owned by Agent 5.
Q12 retry frontend is not enabled: generic 404 also occurs with an old database or unauthorized thread. It cannot safely trigger a resend. Agent 4/5 must confirm supported deployment/storage and provide a positive availability signal.
Opaque capability IDs remain a backend dependency; provider-neutral visible UI does not remove legacy modelKey payloads. No second distinct model is available for multi-capability acceptance.
Upload byte progress, ambiguous-upload reconciliation, Office/PDF previews and completed-answer regeneration were not delivered in this increment. Existing upload activity remains indeterminate.

No backend, migration, infrastructure, deployment, merge or GitHub administration changes.
