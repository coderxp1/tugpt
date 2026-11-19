# Agent 3 / Agent 4: Q-6 and upload alignment

## Scope and preservation

This frontend-only follow-up starts at accepted integration
`8b8eb7ec706ba2dc9732cca1960a8d0bb44c5596`, on a new branch:
`fix/agent3-q6-serialization-upload-regressions`.
The original frontend branch stays at `9080995c91efd89b4c5d9cb0d57d59190729fe2f`.
The accepted 87/87 browser evidence remains under `ws-agent3-m4`; it proves only
that accepted revision and its then-current backend. No backend changes are
cherry-picked here, and no migrations, sessions, servers or previews are changed.

## Exact Agent 4 sources reviewed, read-only

- Q-6: `cb0c8e4a396e0378f3e222db8826d4c287081eb9` on
  `feat/workspace-q6-agents-contract`.
- Q-8: `80cc6c92df48bd82965db45c8977b950e8787979` on
  `fix/workspace-q8-library-upload`.

Routes, resource shaping and backend contract documentation were inspected from
these commits. This is source-level alignment, NOT live API/execution acceptance
or a claim that Agent 4 has acknowledged this follow-up.

## Agents contract retained

The active builder client is `apps/web/src/lib/workspace/custom-agents.ts` (not
the backend-oriented agent client in `lib/workspace-data/contracts.ts`).

- GET `/api/v1/agents` -> `{ agents: CustomAgent[] }`.
- POST `/api/v1/agents` -> 201 `{ agent }`.
- PATCH `/api/v1/agents/{id}` -> 200 `{ agent }`.
- DELETE `/api/v1/agents/{id}` -> 200 `{ deleted: true }`.
- Writes: exactly `name`, `description`, `instructions`, `modelKey`, `starters`,
  `collectionIds`, `visibility`. No `conversationStarters` rename in the frontend.
- Limits: name 80; description 280; instructions 8000; at most 4 starters of 200
  characters; at most 10 selected collection IDs. Blank description -> null;
  blank starters dropped. Model is a catalogue key or null; visibility private
  or organization.
- Response adds `id`, `ownedByMe`, `createdAt`, `updatedAt`. Agent 4 also returns
  `canEdit`, `canDelete`, `version`, `tools`. List items include starters and links.
  Non-editors get `instructions: ""`, preserving privacy and matching the string
  validator; no need to expose prompts or widen the frontend type to null.
- JSON errors are `{ error: "CODE" }`, not a nested error object. Preserve
  same-origin cookies, Origin checks and `x-tugpt-csrf: 1`.
- Expected codes include INVALID_REQUEST, INVALID_MODEL, INVALID_COLLECTION,
  LIMIT_EXCEEDED, FORBIDDEN, NOT_FOUND. Owner-only PATCH returns 404 for others.

### Serialization fix

`cleanAgent` now constructs only the seven editable fields. POST uses it at the
transport boundary; PATCH independently whitelists supplied fields, preserving
omission versus explicit null/empty arrays. Tests include malicious/additive
owner, tenant, permission, timestamp, version, tools and unknown properties.
Thus edit-form response copies cannot echo backend-owned data or accidentally
change tool configuration. No backend echo-field accommodation is required by
this fixed client. Agent 4's existing echo handling is not changed here.

### Collections

Builder reads GET `/api/v1/library/collections` for options and sends selected
IDs inline. No separate agent-link requests are made. Agent 4's atomic save
replaces **caller-visible** links, preserving hidden links; `[]` clears visible
links, omitted PATCH collectionIds preserves them. Every supplied ID must be
readable, with non-disclosing INVALID_COLLECTION errors. This visible-set
qualification supersedes the earlier handoff's unqualified replacement wording.
Retrieval must recheck the executing caller's access. The backend total cap is
20 including hidden links; the builder selects at most 10 visible links.

### Execution and enablement gate

`canWrite = false` remains. Compatible owner and redacted organization-agent
fixtures still cannot enable create/edit/delete or custom run actions. The
composer catalogue remains built-in only. There is no custom `/run` UI call.

Agent 4 now implements optional `agentId` at thread creation, binding later
`/chat/threads/{id}/messages` turns to that agent. The existing frontend still
sends only `{ modelKey }` on creation and `{ content, modelKey, mentions,
timeZone }` on messages. Custom selection, thread restoration, model precedence,
agent/citation NDJSON events and security behavior must be integrated and tested
before activation. The existing messages reader expects user/delta/tool/approval
and terminal done/error NDJSON, not SSE. Source support is not proof of a real
end-to-end run. Future actions must respect canEdit/canDelete rather than only
ownedByMe, including viewer-role cases.

## Library upload contract

Two calls remain:

1. POST `/api/v1/files?filename=...&visibility=...`, raw Blob bytes -> `{ file }`.
2. POST `/api/v1/library/collections/{id}/documents`, `{ fileId, title }` ->
   202 `{ document, created: true }` for a new pending document, or
   200 `{ document, created: false }` for the canonical existing document.

The full `document` wrapper is required; retries return the existing status,
not forced pending or ready. The UI accepts both success codes, replaces a row
by returned document ID, and polls pending/indexing until terminal status.
The result type now has optional `created` exactly as Agent 4's Q-8 client does,
keeping compatibility with older envelopes. False shows a reused-document notice
in English and Spanish using the canonical title; it does not claim a new add.
A lost response is reported as unconfirmed; Refresh performs GET reconciliation,
never automatic write replay. A prior unconfirmed-upload notice can still be
dismissed separately; a dedicated file-ID retry control is not added here.

Regression coverage uses simulated HTTP responses through the real frontend
client and component: 202 pending; 200 false pending/ready/failed; same-ID row
replacement with a newly uploaded file ID; canonical title; polling and stop;
lost-response recovery without replay; missing document wrapper; old envelopes.
These tests do NOT hash bytes or validate backend uniqueness, concurrent races,
worker execution or tenant-scoped content deduplication.

## Remaining verification before activation

1. Integrate the reviewed Agent 4 commits and required migrations in a separately
   authorized isolated environment, not the accepted/shared preview.
2. Verify real CRUD, inline link atomicity, ownership/role permissions, hidden-link
   preservation and execution through agent-bound threads, including citations,
   revoked access, deleted agents, model selection and tool approvals.
3. Wire and test custom-agent UI execution/restoration; only then remove the write
   guard and preview copy. This branch deliberately does not enable them.
4. Rerun real duplicate-byte/concurrent/retry upload cases, worker indexing,
   search and isolation against the NEW Q-8 backend. Do not reuse the previous
   acceptance run to claim content-hash deduplication.
