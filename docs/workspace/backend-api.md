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
| Pagination | `?limit=` (bounded per route) and `?before=`. Pass the previous response's `nextCursor` back unchanged as `before`. `nextCursor` is `null` when there is no further page (also when the last page is exactly `limit` long). Conversations (`GET /chat/threads`) use an opaque cursor (`c1.…`) carrying the exact `updatedAt` and the thread id, so threads with identical timestamps are neither skipped nor repeated (Q-7, migration 20261120100007); a bare ISO timestamp is still accepted there with the old "updated strictly before" meaning. Files and approvals still use an ISO-timestamp cursor. |
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

### Saved threads: agent identity and citations (Q-9, migrations `20261120100010` + `20261120100011`)

`GET /api/v1/chat/threads/{id}` returns `{thread:{id,title,modelKey,updatedAt,agentId}, messages: Message[]}`.
`POST /chat/threads` and the plain `GET /chat/threads` list carry `agentId` too; the search/paged list
(`search_chat_threads`) does **not** yet.

- `agentId` is `null` for plain chat and after the agent was deleted (FK `ON DELETE SET NULL`). A binding to an
  agent the caller can no longer read is still returned; `GET /agents/{id}` then answers 404 and a new message 409.
- Every message has `citations: Citation[]` and `knowledgeUnavailable: boolean`. Only assistant messages can be
  non-empty (CHECK `chat_messages_citations_assistant_only`); user/tool messages are always `[]` / `false`.
- `Citation = {n, documentId, collectionId, fileId, title, ordinal, snippet}`, exactly the streamed `citations`
  event. Shape is enforced in the database (`chat_messages_citations_valid`: ≤20 entries, exactly these keys,
  lowercase uuids, `n` 1–999, `ordinal` ≥0, title 1–255, snippet ≤2000 characters). Since `20261120100011` the
  validator returns exactly true/false (never NULL, which a CHECK would let through): empty objects, JSON null
  anywhere, missing/extra keys and wrong value types are all rejected.
- Stored citations are a **snapshot** written together with the assistant message. On every read they are
  re-authorized under the reader's RLS: a citation whose document is no longer readable, was deleted or moved
  to another collection/file is **omitted** (remaining entries keep their original `n`). The stored row is not
  changed, so regained access restores it. Title renames are not reflected.
- A failed knowledge search is persisted as `knowledgeUnavailable: true` with `citations: []`.
- Another user, another tenant or a forged tenant claim gets `404` for the thread; there is no oracle for
  `agentId` or citations.

### Idempotent turns: retry and recovery without re-sending (Q-12, migration `20261121100001`)

A **turn** is one user message plus the assistant (and tool) messages written for it. The client creates
the turn id (`crypto.randomUUID()`) **before** sending and keeps it until the turn settles. Every field is
optional. Since Q-16, a send **without** `turnId` gets a server-minted one (lowercase UUID v4, `retry:false`):
it is echoed in the `user`, `done` and `error` events, stamps the user message, claims the turn lease and
keys usage rows. A client may adopt it for `GET …/turns/{turnId}` and `retry:true`. On a database without
turn ids (`TURNS_UNSUPPORTED`) the turn id stays `null`, as before.

| Method & path | Body | Result |
|---|---|---|
| `POST /api/v1/chat/threads/{threadId}/messages` | `{content, modelKey, mentions?, timeZone?, turnId?, retry?}` | `200` NDJSON stream; or `409 {error, code, turn}` (no model call, no write) |
| `POST /api/v1/agents/{agentId}/run` | `{content, threadId?, modelKey?, timeZone?, turnId?, retry?}` | same; retrying needs the thread, so a run started without `threadId` is retried with the `threadId` from its `agent` event |
| `GET /api/v1/chat/threads/{threadId}/turns/{turnId}` | none | `200 {turn}`; `404 {code:'TURN_NOT_FOUND'}` = your thread, turn never stored; `404 {code:'THREAD_NOT_FOUND'}` = no such thread for you; `501 {code:'MIGRATION_PENDING', feature:'chat.turns'}` = database without turn ids (Q-14) |

`turn` = `{id, status, latest, userMessage, assistantMessage}`. `status`:

| status | meaning | client action |
|---|---|---|
| `complete` | answered | show `assistantMessage` |
| `error` | the model call failed; the error answer is stored | offer **Retry** |
| `stopped` | the stream ended early (client disconnected or pressed stop); the partial answer is stored | offer **Retry** / **Continue** |
| `pending` | a run holds the turn's lease (Q-13; this includes a **retry** of an `error`/`stopped` turn that is running now), or, without a lease, a stored user message with no answer that is younger than 150 s (`maxDuration` is 120 s) | poll the GET (e.g. every 1–2 s) |
| `interrupted` | no answer, no live lease, and older than 150 s (the server died mid-turn) | offer **Retry** |

**Stream changes (additive):** the `user` event gains `turnId` and `retried`; `done` and `error` gain `turnId`;
every message carries `turnId` (`null` when sent without one). `GET /chat/threads/{id}` returns `turnId` on
each message too.

**POST with a `turnId` that already exists** never writes a second user message:

| situation | response |
|---|---|
| no `retry` (a re-send after an ambiguous failure) | `409 TURN_EXISTS` + `turn` (any status) |
| `retry: true`, status `error` / `stopped` / `interrupted`, latest turn, same content | **re-runs** the turn on the existing user message (`user` event has `retried: true`, same message id) |
| `retry: true`, status `complete` | `409 TURN_EXISTS` |
| `retry: true`, status `pending` | `409 TURN_IN_PROGRESS` |
| `retry: true`, not the thread's latest user turn | `409 TURN_NOT_LATEST` |
| different `content` for the same `turnId` | `409 TURN_CONFLICT` |
| `retry: true` for a turn the server never stored | treated as a fresh send |
| two identical sends at the same moment | one stream; the other gets `409 TURN_IN_PROGRESS` (unique index + run lease) |
| two `retry: true` at the same moment | **one** model call; the other gets `409 TURN_IN_PROGRESS` (run lease, Q-13) |
| `retry: true` that lost a race with an attempt that has **finished** | `409` with the turn as it is now: `TURN_EXISTS` (now `complete`), `TURN_NOT_LATEST` (a newer message was sent) or `TURN_CHANGED` (another attempt stored a new non-complete answer; re-read and offer Retry again) |

`400 "Invalid request"`: a malformed `turnId` (not a UUID), a non-boolean `retry`, or `retry` without a `turnId`.

**Recommended client flow after an ambiguous failure** (network error, 5xx, stream ended without `done`/`error`):
1. `GET .../turns/{turnId}`. Only `404` with `code: TURN_NOT_FOUND` means send again with the **same** `turnId`
   (Q-14; a 404 without that code, `THREAD_NOT_FOUND` or `501 MIGRATION_PENDING` is **not** a resend signal). `pending` means poll.
   `complete` means render it. `error` / `stopped` / `interrupted` means show Retry.
2. Retry = `POST .../messages {content, modelKey, turnId, retry: true}`.
3. Never re-send a prompt with a **new** `turnId` unless the person asks to.

**Persistence:**
- The user message is written before the stream starts.
- The answer is written when the stream ends: `complete`, `error` or `stopped` (with the text streamed so far).
- If the process dies in between, there is no answer row; the turn reads `pending`, then `interrupted`.
- A retried turn keeps its earlier answer rows. The thread shows each attempt in order; the turn's status
  and `assistantMessage` are the **latest** attempt. Render one bubble per `turnId` (the last assistant
  row), or show earlier attempts collapsed.
- The model is sent only the latest answer of each turn, never failed answers, and the retried prompt once.

**Security:**
- `turn_id` is writable by the owner only on their own `role = 'user'` messages.
- Assistant and tool rows get it only through the server-only `append_chat_turn_message_server`, which
  also requires the turn to have been opened in that very thread.
- Other users and tenants get `404`.

### Turn-less sends are turns (Q-16; no migration)

Before Q-16 a send without `turnId` wrote an unstamped user message and **recorded no usage row** (the
meter needs a turn). The shipped client (`useChatSession`) sends no `turnId`, so real chat traffic was
unmetered (USAGE-1 root cause 1). Now `withServerTurnId` (`lib/chat/turn-send.ts`) mints the id in the
messages route and in `runAgentTurn` (covers `agents/{agentId}/run`).

- A client-supplied `turnId` is passed through unchanged (validation as before).
- **Duplicate submissions without a client `turnId` are separate turns**: each gets its own id, one model
  call and one usage row. The server cannot dedupe them; only a client-created `turnId` can (Q-12).
- `retry:true` without `turnId` is still `400` (nothing to retry).
- Verify usage from the real client: read the `turnId` from the `done`/`error` event, then count
  `provider_usage_events` rows with that `chat_turn_id`; keys are `chat:<turnId>:<callIndex>`
  (`agents:` for agent turns). One row per model call, retries at `callIndex` 8, 16, ….

### Regenerate vs retry (Q-14 contract, request 2)

| Action | Supported | Behaviour |
|---|---|---|
| Retry the **latest** turn in `error` / `stopped` / `interrupted` | yes (`chat.turns`; single run with `chat.turnRunLease`) | `POST .../messages {content, modelKey, turnId, retry:true}` re-runs on the **same stored user message** (no second user row): retrieval and tools run again, one model call |
| Regenerate a **complete** answer | **no** (`chat.regenerateCompleted` = `unavailable`) | `409 TURN_EXISTS` with the stored `turn`; no model call |
| Retry an older turn | no | `409 TURN_NOT_LATEST` |
| Two retries at once | one runs | the other gets `409 TURN_IN_PROGRESS` (lease) |

Side effects on retry: built-in chat tools are read-only. Customer MCP tools whose permission class is not `read` need a
**single-use** approval (`claim_tool_approval`, `used_at`); a retry cannot reuse a consumed approval, so it gets
`APPROVAL_REQUIRED` and nothing runs again without a new human approval. Agent threads use the same turn decision and lease.

### Feature signal (Q-14, request 1)

`GET /api/v1/chat/features` (session; read-only; `Cache-Control: private, no-store`). Not to be confused with
`GET /api/v1/chat/capabilities` (the @-picker tool catalogue).

```json
{ "contract": "workspace-features/1",
  "features": {
    "chat.turns": {"state": "available"},
    "chat.turnRunLease": {"state": "migration_pending", "missingMigrations": ["20261122100001_workspace_chat_turn_runs"]},
    "chat.regenerateCompleted": {"state": "unavailable", "reason": "NOT_IMPLEMENTED"},
    "files.uploadIdempotency": {"state": "available"},
    "library.writeRefusals": {"state": "available"},
    "library.atomicDocumentMove": {"state": "unavailable", "reason": "NOT_IMPLEMENTED"},
    "files.preview": {"state": "unavailable", "reason": "NOT_IMPLEMENTED"} } }
```

| State | Meaning |
|---|---|
| `available` | code deployed and the database has the migration |
| `migration_pending` | code deployed, database lacks `missingMigrations` (expand window); backend behaves like the previous release |
| `unavailable` + `NOT_IMPLEMENTED` | not in this build |

Probes are row-less (`limit(0)`) selects under the caller's RLS; only "relation/column does not exist" counts as
`migration_pending`, anything else is `503 STORE_UNAVAILABLE`. `401` without a session. **Client rule:** use a contract
only when its key is `available`; a missing key, `404` (pre-Q-14 deployment) or `503` means unknown → legacy behaviour.
Worker-side features (document formats) are not reported: the web app cannot see the worker build.

### Turn runs: one model call per turn (Q-13, migration `20261122100001`)

- Before calling the model, the server claims a **lease** on the turn (`chat_turn_runs`, one row per turn,
  server-only `claim_chat_turn_run_server` / `release_chat_turn_run_server`; TTL 150 s). A claim fails if
  another run holds a live lease, if the turn changed since the request read it, or if it is no longer the
  thread's latest user turn. A refused claim never calls the model.
- The lease is released when the answer is stored. If the server process dies mid-answer, nothing partial
  is stored and the turn reads `pending` (retries get `409 TURN_IN_PROGRESS`) until the lease expires
  150 s after the claim. Then a fresh turn reads `interrupted` and a retried turn reads its last stored
  answer (e.g. `error`), and Retry runs it once. Clients should therefore keep polling a `pending` turn
  for up to ~155 s before treating it as stuck. Measured over HTTP with a real `SIGKILL` of the server
  (`chat-crash-recovery-http.e2e.mjs`): `pending` from 3 s to 150 s, `interrupted`/`error` at 152 s,
  then Retry completed on the same user message with one model call.
- `GET .../turns/{id}` and the retry decision read the lease, so a running retry reads `pending`
  instead of the old `error`.
- **Long threads:** `GET /chat/threads/{id}` returns the **latest** 400 messages, oldest first. (Before
  Q-13 it returned the oldest 400, so the newest turns of a long thread were missing.) Turn status and
  `latest` are computed with indexed per-turn queries, independent of thread length.
- On a database without `20261122100001` the app behaves as in Q-12 (no lease; see operations §1c).

### Capabilities, call deadlines and usage metering (Q-15: CONF-1, TIMEOUT-1, USAGE-1; no migration)

**CONF-1 — opaque capability ids.** Customer responses never carry a provider, upstream model id,
host, port or endpoint.

- `GET /api/v1/chat/capabilities/models` (session required, `401` otherwise; `Cache-Control: no-store`)
  returns `{ contract: "chat-model-capabilities/1", capabilities: [{ id, label, description, available,
  reasonCode, features: { toolCalling } }], defaultCapabilityId }`. `reasonCode` is `null`,
  `TEMPORARILY_UNAVAILABLE` or `NOT_PERMITTED`. It is built only from the public model list, never from
  routing data.
- Ids: the private model is `assistant` ("TuGPT Assistant"). Hosted routes are `hosted-<8 hex>`
  ("TuGPT Assistant (hosted option N)"; **interim labels until ROUTE-1**). A stored key that left the
  catalogue reads as `retired-<8 hex>` and resolves to nothing.
- Outputs (threads, thread list, agents, agent threads, agent turns) carry **both** `capabilityId` and
  `modelKey`, and both hold the opaque id. `modelKey` stays for compatibility; new clients should read
  `capabilityId`.
- Inputs (`POST /chat/threads`, `POST .../messages`, `POST .../approved-call`, agents create/PATCH)
  accept `capabilityId`. The legacy `modelKey` is still accepted, including a legacy stored key such as
  `tugpt-scout`, as an alias. If both are sent and differ, the request is refused like an unknown
  capability: `400 {"error":"Unknown model"}` on the chat routes (the existing body; agent runs use
  `UNKNOWN_MODEL`) and `400 INVALID_MODEL` on agent create/PATCH.
- Stored values are unchanged: `chat_threads.model_key` / `custom_agents.model_key` keep the internal
  routing key. An agent whose stored model is retired can still be saved by echoing its `retired-*` id
  back unchanged; the stored key is kept. It cannot be newly chosen.
- Images API responses no longer include a model field.
- Images `errorCode` is a closed, neutral set (IMAGES-NEUTRAL): `GENERATION_FAILED`,
  `GENERATION_INTERRUPTED`, `JOB_NOT_FOUND`, `RESULT_EXPIRED` or `null`. The image service's raw codes
  stay in `image_generations.error_code` (backend-only). Mapping: `GPU_INFERENCE_FAILED` to
  `GENERATION_FAILED`; `GPU_SHUTDOWN` to `GENERATION_INTERRUPTED`; anything unknown to
  `GENERATION_FAILED`. Applied in `publicImage`, so it covers list, create, status and cancel.

**TIMEOUT-1 — every model call ends.** Each call has a first-token deadline (25 s: request sent to
first answer text, or the whole tool-round response), an idle deadline (20 s between chunks after the
first text) and a hard cap. The cap is `min(totalMs (100 s), turn deadline − now)`. All calls of one
turn share a **turn budget of 100 s** (`TURN_BUDGET_MS`, not configurable upward), so a turn always ends
before the route's `maxDuration` (120 s) and before its 150 s turn lease can expire. Without that, an
answer still streaming after the lease expired could race a Retry into a second model call. This
matters because `next start` does not enforce `maxDuration`.

- When a deadline fires, the upstream request is aborted, the stream ends with
  `{type:'error', code:'MODEL_TIMEOUT', message, turnId}`, the answer is stored as `error`, and the
  lease is released, so Retry works at once. Text already streamed is kept as the stored partial answer.
  An empty answer stores "The model could not be reached. Try again in a moment."
- Upstream HTTP errors or a refused connection: `MODEL_UNAVAILABLE`, returned at once. Neither code
  carries provider detail.
- A client disconnect is a stop, not a timeout: the answer is stored `stopped`.
- Measured over HTTP against the scripted upstream (`rc-blockers-q15-http.e2e.mjs`): idle stall
  20.1 s, no text after headers 25.1 s, no response headers 25.1 s, HTTP 500 in 0.1 s.
- Disposition (reasoning): only visible answer text (`delta.content`, non-empty) counts as the first
  token. `reasoning` / `reasoning_content` deltas, role chunks, `: ping` keep-alives, empty strings and
  malformed lines do not, so a model that thinks silently for more than 25 s is cut with
  `MODEL_TIMEOUT`. This is deliberate: the customer sees nothing during hidden reasoning. The deployed
  private model (Llama 4 Scout) emits no reasoning deltas. For a reasoning route, raise
  `TUGPT_CHAT_FIRST_TOKEN_TIMEOUT_MS`; the 100 s turn budget still applies.
- Cold model load: if the private model is not resident (Ollama unloads after 5 min idle by default),
  the first request waits for the load without sending headers. If the load exceeds 25 s, that request
  ends `MODEL_TIMEOUT`. **Not measured yet**: see the real-model verification procedure (Agent 5).

#### TIMEOUT-1 edge cases (Q15 follow-up)

| Case | Behaviour | Test |
|---|---|---|
| Silent before first text: no headers / headers + role chunk / keep-alives / reasoning-only / empty or malformed deltas | `MODEL_TIMEOUT` after the first-token deadline; upstream aborted; nothing shown; stored `error` | `timeouts.test.ts`; E2E T2, T3 |
| Stream ends cleanly with no text (plain chat) | `MODEL_BAD_RESPONSE`; stored as a retryable `error` (was: an empty `complete` answer that could never be retried) | `turn-partial.test.ts`; E2E T6 |
| Partial text, then a stall | `MODEL_TIMEOUT` after the idle deadline; partial text kept as the stored `error` answer | E2E T1 |
| Model fails **after a tool ran** (2nd tool round, final answer stream, approved-call answer) | Cleaned partial text + "The tool ran, but TuGPT's answer was interrupted before it was complete. Ask again for a summary of the result." + the approval sentence if a card is waiting; original error code (`MODEL_TIMEOUT` / `MODEL_UNAVAILABLE`) kept; stored `error`; the tool ran exactly once | `turn-partial.test.ts` (6 cases) |
| Model fails before any tool ran | Unchanged: no text, original error code | `turn-partial.test.ts` |
| Server crash during usage recording | See USAGE-1 "Crash during recording" below | `usage-meter.test.ts`; E2E T7 |
| Retry after a timeout | Lease released when the error is stored; the timed-out upstream request is closed **before** the retry's request reaches the model; exactly 2 upstream requests; usage idx 0 `failed` + idx 8 `succeeded` | E2E T1–T3 |
| Duplicate provider calls | Concurrent retries of one turn (T4) and a double submit of a new turn (T8): one runs, the other gets `409`, exactly one model call and one usage row. A complete turn cannot be re-run (`409 TURN_EXISTS`, U2) | E2E T4, T8, U2 |

Retry re-runs the turn from the start, so read-only tools run again on a retry. Data-changing tools
cannot repeat a change: they need an approval, and an approval is claimed once
(`claim_tool_approval_audited`).

**USAGE-1 — one usage row per model call** (Agent 6's `recordChatUsage`, table from
`20261121700002_usage_accounting`).

- Key: `<feature>:<turnId>:<callIndex>`, with `callIndex = attempt × 8 + n`. `n` is the call within the
  attempt (tool rounds, then the answer), and `attempt` is 0 for a fresh turn or the number of stored
  answers for a retry (maximum 63). So a retry never reuses a key, and a duplicate request that loses
  the lease (`409`) makes no call and writes no row.
- Turn-less sends (no client `turnId`) are metered on the server-minted turn id (Q-16).
- Feature: `chat` (messages, approved-call) or `agents` (agent turns). Approved-call has no chat turn,
  so it uses a per-request random turn id with attempt 0.
- Outcome: `succeeded`, `failed` (timeout, upstream error) or `cancelled` (client stop). A consumer
  that stops reading early, e.g. at a leaked role header, counts as `succeeded`.
- Tokens come from the provider's final `usage` chunk (`stream_options.include_usage` is sent;
  `TUGPT_CHAT_STREAM_USAGE=false` disables it for an upstream that rejects it).
- **Unknown usage (disposition).** Without a provider `usage` object, Workspace passes `usage: null`
  (never 0) and the event is recorded with `usage_basis = 'unavailable'` and NULL cost. **The event's
  `usage_basis` is the authoritative marker.** Agent 6's `record_chat_usage` currently also writes
  `input_tokens` / `output_tokens` components with quantity 0 for such events (`COALESCE(..., 0)`),
  while their contract said "tokens stored: NULL". Readers must therefore treat token quantities of an
  `unavailable` event as unknown, never as 0. The customer report `org_usage_report` already does this:
  it adds nothing to the token sums and counts the event in `unmetered_requests`. The service-role
  `org_usage_summary` is basis-unaware. The clean-up landed in S0.4 (migration
  `20261125000003_usage_unavailable_no_quantities`, gate defect U6): `record_chat_usage` now writes
  NO token components for `unavailable` events, and the zero-quantity components written by the old
  code were deleted. A provider-reported 0 is
  different: `usage_basis = 'reported'` with 0 tokens, not unmetered (E2E U6).
- **Crash during recording.** A run that recorded calls but died before storing its answer leaves
  `attempt` unchanged, so the next run's first key collides (`duplicate`). A meter records each of its
  own calls exactly once, so a `duplicate` it receives always belongs to another, dead run: it moves to
  the next attempt slot (`+8`) and keeps that shift for its later calls, giving up with a log past 63.
  Result: no under-count for the new run and no double count. The residual case, a crash between a
  model call and its record, loses that one record. That is an under-count, never a double count
  (`record_chat_usage` is a single transaction).
- Rows are written after the lease is released. They are best-effort: a recording failure never fails
  the turn.
- Provider and upstream model are stored on the row (backend-only). The customer report
  `org_usage_report` exposes neither, and neither does any customer response.

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

**What gets read for knowledge (indexing / RAG)**: uploading accepts every allowlisted type, but only these
are extracted into searchable text when a file is added to a knowledge collection
(`packages/workspace-core/src/extract.ts`):

| Type | Indexed | Notes / document error codes |
|---|---|---|
| txt, log, md, markdown, csv, json | yes | strict UTF-8 |
| docx | yes | visible text of `word/document.xml`; field codes and tracked deletions dropped |
| xlsx | yes | every sheet, one paragraph per non-empty row; ≤100 sheets, ≤500 000 cells (`DOCUMENT_TOO_LARGE`) |
| pdf | yes, if it has a text layer | worker-side extractor; `PDF_ENCRYPTED`, `PDF_NO_TEXT_LAYER` (scans; no OCR yet), `PDF_EXTRACTION_UNAVAILABLE` |
| pptx | yes (Q-13) | slide text in presentation order, then speaker notes: `Slide N: …` / `Slide N notes: …`; text boxes and tables included; ≤1 000 slides (`DOCUMENT_TOO_LARGE`) |
| png, jpg/jpeg, gif, webp | **no** | stored and attachable, but not searchable: `UNSUPPORTED_FOR_INDEXING` (no OCR yet) |

Text is capped at 2 000 000 characters and 2 000 chunks. Other outcomes: `EMPTY_DOCUMENT` and `EXTRACTION_FAILED`.

**Upload retries (Q-13, migration `20261122100002`):** send an `Idempotency-Key: <uuid>` header and reuse it
when retrying the same upload. Keys are scoped per tenant and user.

| situation | response |
|---|---|
| first request with a key | `201 {file}` as usual |
| same key, same bytes (SHA-256 and size), first upload `ready` | **`200 {file, replayed: true}`**: the original file; nothing is stored again; `filename`/`visibility` of the retry are ignored |
| same key, different bytes | `409 IDEMPOTENCY_KEY_REUSED` |
| same key while the first request is still storing | `409 UPLOAD_IN_PROGRESS` with `Retry-After: 2`; retry with the same key |
| same key, earlier attempt `failed` | treated as fresh (`failed` rows don't hold the key): `201` |
| same key, earlier attempt abandoned (`uploading` for more than 120 s, e.g. a crash) | its row and blob are removed, then `201` |
| malformed key (not a UUID) | `400 INVALID_IDEMPOTENCY_KEY` |
| no header | not idempotent (pre-Q-13 behaviour): every successful call creates a new file |

- Failures roll back: if storage or the database fails, the row and blob are removed, and you get
  `503 STORAGE_UNAVAILABLE` / `STORE_UNAVAILABLE`. Nothing is left visible as `ready`.
- Without a key, after an **ambiguous** failure, look in `GET /api/v1/files?scope=mine` for a `ready` file
  with the same `filename`, `sizeBytes` and `sha256` before re-uploading.
- On a database without `20261122100002` the header is accepted but ignored (no de-duplication).
- Adding the same content to the same collection twice is de-duplicated by the database (one document
  per content per collection).
- There are no file folders in the API yet; files are listed per owner (`scope=mine`) or per organization.

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
| `DELETE /api/v1/library/collections/{id}/documents/{docId}` | none | `200 {deleted:true}` (the file is kept). Q-14: `403 FORBIDDEN` if you can read the collection but not change it; `404` only when the document (or collection) is not there for you, so a 404 on a repeated remove means already removed | writers |
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
  pdfjs in the worker (page/char/time limits; image-only scans end as `failed` with `PDF_NO_TEXT_LAYER`, corrupt
  PDFs as `EXTRACTION_FAILED`; **no OCR yet**); **PPTX** (slides in order plus speaker notes, Q-13). Chunks
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

### Move, dedupe and roles (Q-14, request 3)

* **Move** is two calls (no atomic move: `library.atomicDocumentMove` = `unavailable`): `POST` to the destination
  (`202`, a **new** document id, indexed again), then `DELETE` from the source. Destination first: on failure the file
  stays findable in at least one collection. `404` on the source remove = already removed; `403` = not allowed (stop).
  The file is never deleted by a move.
* **Dedupe:** adding the same file again returns the existing document (`200 created:false`); a different file with
  identical bytes (`content_sha256`) in the same collection also returns the existing document.
* **Roles** (org collections): owner/admin create, rename, add and remove; manager/agent/viewer read and search only
  (`403 FORBIDDEN` on write). Private collections: the creator only; everyone else `404`. A member can search an org
  collection containing an owner's private file but cannot read its metadata or download it (`404`).

### Citations after library changes (Q-14, request 4)

A stored citation is returned only while that exact document still exists in that collection and the reader can read the
collection; the answer text is always kept. Unlinking a collection from the thread keeps citations; switching an org
collection to private hides them for others (they return when switched back); moving the document out or deleting the
file hides them permanently (re-adding creates a new document id, the old citation stays hidden).

### Upload flow and failure semantics (Q-8)

A Library upload is `POST /api/v1/files` followed by `POST …/documents`. Each step either succeeds or leaves nothing misleading behind:

| Failure | Response | What remains |
|---|---|---|
| Storage write fails | `503 STORAGE_UNAVAILABLE` from `/files` | No file row (removed again), no document |
| Storage not configured | `503 STORAGE_NOT_CONFIGURED` | Nothing |
| File not `ready` (upload still running, or crashed) | `409 CONFLICT` from `…/documents` | No document; stale `uploading` rows are purged by maintenance (§5c) |
| Response of `…/documents` lost, client retries | `200 {created: false}` | One document |
| Several retries race (parallel requests, same file) | Exactly one `202 {created: true}`, the rest `200 {created: false}`; every response carries the same complete document | One document |
| Same file added again after its document was removed | `202 {created: true}` with a **new** id | One document (the removed one is gone) |
| Document removed while a duplicate add is in flight | The add retries once and returns `202`; `409 ALREADY_EXISTS` only if the slot is taken and freed twice in a row | One document |
| Same bytes in another collection or another tenant | `202 {created: true}`: dedupe is per collection, and a collection belongs to one tenant | One document per collection |
| User drops the same file again (new file id, same bytes) | `200 {created: false}`, existing document | One document; the second *file* stays in the user's files (it is a real upload) |
| No write access | `403 FORBIDDEN` (collection readable) / `404 NOT_FOUND` (not readable, other tenant, forged tenant) | Nothing |

On `200` the document is returned exactly as stored (id, title, status, counters); a different `title` on a retry does not rename it. The response never claims more than is true: a new document is `pending`, and it is neither `ready` nor searchable until the worker has stored its chunks. The web role cannot write chunks at all (`replace_document_chunks` is not executable by `authenticated` since `20261120100002`).

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
| 400 | `INVALID_REQUEST`, `INVALID_FILENAME`, `INVALID_SCOPE`, `INVALID_STATUS`, `INVALID_THREAD`, `INVALID_ENDPOINT`, `INVALID_CAPABILITY`, `INVALID_ARGUMENTS_HASH`, `INVALID_PREVIEW`, `INVALID_REASON`, `INVALID_DECISION`, `INVALID_NOTE`, `INVALID_TTL`, `QUERY_REQUIRED`, `QUERY_TOO_LONG`, `TOO_MANY_COLLECTIONS`, `INVALID_REQUESTER`, `INVALID_EMBEDDING`, `INVALID_ACTION`, `MESSAGE_INVALID`, `UNKNOWN_MODEL`, `INVALID_IDEMPOTENCY_KEY` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, `INVALID_ORIGIN` |
| 404 | `NOT_FOUND` |
| 409 | `ALREADY_EXISTS`, `CONFLICT`, `ALREADY_DECIDED`, `REQUEST_EXPIRED`, `INVALID_STATUS_TRANSITION`, `FILE_CONTENT_IMMUTABLE`, `AGENT_MODEL_UNAVAILABLE`, `AGENT_TOOL_CONFLICT`, `THREAD_AGENT_MISMATCH`, `TURN_EXISTS`, `TURN_IN_PROGRESS`, `TURN_NOT_LATEST`, `TURN_CONFLICT`, `TURN_CHANGED` (chat turns, body has `turn`), `IDEMPOTENCY_KEY_REUSED`, `UPLOAD_IN_PROGRESS` (with `Retry-After`) |
| 413 | `PAYLOAD_TOO_LARGE`, `ARGUMENTS_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `MEDIA_TYPE_MISMATCH` |
| 429 | `RATE_LIMITED` (with `Retry-After`), `LIMIT_EXCEEDED`, `TOO_MANY_PENDING`, `TOO_MANY_CHUNKS` |
| 503 | `STORE_UNAVAILABLE`, `STORAGE_NOT_CONFIGURED`, `STORAGE_UNAVAILABLE`, `INTEGRITY_CHECK_FAILED` |
| stream `error` event | `MODEL_TIMEOUT` (a deadline fired, Q-15), `MODEL_UNAVAILABLE` (upstream error or unreachable), `MODEL_BAD_RESPONSE`, `TURN_FAILED`, `STORE_UNAVAILABLE` |

### 7a. Client handling (frontend quick reference)

Every error body is JSON with `code`; turn conflicts also carry `turn` (the turn as it is now).

| Response | Meaning | Client action |
|---|---|---|
| `409 TURN_EXISTS` | the turn already has a stored answer | render `turn` (`complete` → done; otherwise offer Retry) |
| `409 TURN_IN_PROGRESS` | another request (tab, double click, crashed server's lease) is answering | no error toast; poll `GET .../turns/{turnId}` every 1–2 s (up to ~155 s) |
| `409 TURN_CHANGED` | another attempt stored a new answer meanwhile | render `turn`; offer Retry again if it is not `complete` |
| `409 TURN_NOT_LATEST` | a newer message was sent after this turn | render `turn`; no Retry for this turn |
| `409 TURN_CONFLICT` | same `turnId` with different content | client bug: new message → new `turnId` |
| `404 TURN_NOT_FOUND` (turn GET) | your thread, turn never stored | resend with the same `turnId` |
| `404 THREAD_NOT_FOUND` / `501 MIGRATION_PENDING` (turn GET) | not your thread / database without turn ids | do **not** resend blindly |
| `403 FORBIDDEN` on library remove/rename/delete | readable, not writable | explain; do not treat as removed |
| `200 {file, replayed: true}` | upload retry, same file | treat like `201` |
| `409 UPLOAD_IN_PROGRESS` + `Retry-After` | first upload with this key still storing | wait `Retry-After` seconds, retry with the same key |
| `409 IDEMPOTENCY_KEY_REUSED` | key used for different bytes | client bug: new file → new key |
| `400 INVALID_IDEMPOTENCY_KEY` | key is not a UUID | client bug |
| `429 RATE_LIMITED` + `Retry-After` | rate limit | wait, then retry |
| stream `error` `MODEL_TIMEOUT` / `MODEL_UNAVAILABLE` | the model call failed; the answer (with any partial text) is stored as `error` and the lease is released | show the stored text; offer Retry at once (it gets a new usage key) |
| document `failed` + `PDF_NO_TEXT_LAYER` | scanned PDF, no OCR yet | "This PDF has no text layer (a scan). OCR is not available yet." |
| document `unsupported` + `UNSUPPORTED_FOR_INDEXING` | images | stored and attachable, not searchable |

## 8. Configuration (server-only environment)

| Variable | Meaning |
|---|---|
| `TUGPT_FILE_STORAGE` | `fs` or `s3`. **If unset, uploads and downloads fail closed** with `503 STORAGE_NOT_CONFIGURED`. |
| `TUGPT_FILE_STORAGE_DIR` | `fs`: an absolute directory. Files are written `0600` and directories `0700`; writes are atomic (tmp file, then rename). |
| `TUGPT_S3_ENDPOINT`, `TUGPT_S3_BUCKET`, `TUGPT_S3_REGION`, `TUGPT_S3_ACCESS_KEY_ID`, `TUGPT_S3_SECRET_ACCESS_KEY` | `s3`: any S3-compatible store (SigV4, path-style). The endpoint must be HTTPS with no userinfo, and redirects are refused. Load the credentials from the secret store, never from the repo. |
| `TUGPT_FILE_MAX_BYTES` | Upload cap, default 26214400, clamped to 52428800. |
| `TUGPT_APP_ORIGIN` | The exact origin used for the mutation check. |
| `TUGPT_EMBEDDINGS_URL`, `TUGPT_EMBEDDINGS_MODEL`, `TUGPT_EMBEDDINGS_DIMS`, `TUGPT_EMBEDDINGS_API_KEY` | OpenAI-compatible `/embeddings` endpoint, used by the worker (documents) and the web app (queries). HTTPS, or http on loopback only. All three of URL/model/dims are required, otherwise search is keyword-only. The key comes from the secret store. |
| `TUGPT_CHAT_FIRST_TOKEN_TIMEOUT_MS`, `TUGPT_CHAT_IDLE_TIMEOUT_MS`, `TUGPT_CHAT_TOTAL_TIMEOUT_MS` | Per-call model deadlines in ms (Q-15). Defaults 25000, 20000, 100000; values outside 1000..600000 are ignored. Always capped by the 100 s turn budget. |
| `TUGPT_CHAT_STREAM_USAGE` | `false` stops sending `stream_options.include_usage` (for an upstream that rejects it); usage rows are then `unavailable`. Default on. |
| `TUGPT_STALE_UPLOAD_MINUTES`, `TUGPT_BLOB_SWEEP_GRACE_HOURS`, `TUGPT_BLOB_SWEEP_DELETE`, `TUGPT_ORG_PURGE_ENABLED`, `TUGPT_ORG_PURGE_GRACE_DAYS` | Maintenance worker (section 5c). Defaults 60 min, 24 h, `false`, `false`, 30 days. Destructive steps are opt-in. |

## 9. Migrations (forward-only, new IDs)

`20261119100001_workspace_conversations` · `…100002_workspace_approval_requests` · `…100003_workspace_files` ·
`…100004_workspace_library` (frozen), then `20261120100001_workspace_knowledge_vectors` ·
`…100002_workspace_document_jobs` · `…100003_workspace_rate_limits` · `…100004_workspace_custom_agents` ·
`…100005_workspace_storage_maintenance` · `…100006_workspace_document_dedupe` (one document per content per collection) ·
`…100007_workspace_conversation_cursor` (composite thread cursor) · `…100008_workspace_agent_save` (atomic agent save) · `…100009_workspace_agent_owner_edit` (owner-only editing in the database, atomic single link) · `…100010_workspace_message_citations` (persisted citations and `knowledge_unavailable` on assistant messages, Q-9) · `…100011_workspace_message_citations_strict` (validator fix: `[{}]` and every other NULL-producing input were accepted by 100010; the function now never returns NULL, existing rows are re-validated, Q-9b), then the Q-9c security fixes `20261120200001_workspace_agent_instructions_confidential` (no column read of `custom_agents.instructions`; editors read it via `custom_agent_instructions`, runs via the server-only `custom_agent_run_instructions`, F-1) · `…200002_workspace_message_citations_confidential` (no column read of `chat_messages.citations`; `chat_message_citations` returns each entry only while the reader can still read that document in the same collection and file, F-2) · `…200003_workspace_server_authored_messages` (clients insert `role = 'user'` rows with seven columns only; assistant/tool rows only via the server-only `append_chat_message_server`, which re-checks thread owner, tenant, membership and that the thread is not archived, F-3), then `20261121100001_workspace_chat_turns` (Q-12: nullable `chat_messages.turn_id`, one user message per thread and turn, owner-writable on user messages only, assistant/tool rows stamped via the server-only `append_chat_turn_message_server`; additive), then Q-13 `20261122100001_workspace_chat_turn_runs` (`chat_turn_runs` lease table, server-only claim/release functions; additive) · `20261122100002_workspace_file_upload_request_ids` (nullable `workspace_files.upload_request_id`, partial unique index per tenant, owner and key, excluding `failed`; additive). All are registered in `supabase/migrations/checksums.json`. Any
further change needs a **new** migration ID.

## 10. Tests

| Suite | Command | Notes |
|---|---|---|
| Unit | `pnpm --filter web test` (includes `workspace-data.test.ts`, `agents.test.ts`); `pnpm --filter @tugpt/workspace-core test`; `pnpm --filter worker test` | Hermetic. SigV4 AWS vectors, path traversal, validation, DOCX/XLSX/PDF extraction and zip bombs, embeddings client, worker retry/lease logic, maintenance, agent prompt fencing and retrieval query, CSRF and the client |
| pgTAP | `supabase/tests/database/workspace_{conversations,approval_requests,files,library,document_jobs,rate_limits,custom_agents,storage_maintenance}.test.sql` | RLS, grants, RPCs, job state machine, hybrid search isolation, cross-tenant rules, audit |
| Integration (real PostgREST and RLS) | see `apps/web/tests/workspace-it/README.md` | Skipped unless `WS_IT_POSTGREST_URL` is set. Disposable DB only. Runs the real knowledge worker as `service_role`, a loopback fake embeddings server (hashed trigrams) and a loopback fake LLM (SSE) |
| Unit (Q-13 regressions) | `pnpm --filter web test`; `pnpm --filter @tugpt/workspace-core test` | `upload-idempotency.test.ts` (key parsing, replay / mismatch / in-progress / abandoned, `Retry-After`); `turns.test.ts` (lease claims and 409 mapping); `workspace-core.test.ts` PPTX suite (slide order, speaker notes, tables, slide cap) |
| pgTAP (Q-13) | `workspace_chat_turn_runs.test.sql`, `workspace_file_upload_request_ids.test.sql` | lease claim/release/expiry, server-only grants, per-owner upload-id uniqueness, isolation |
| HTTP E2E (fake model, SIMULATED; disposable DB only) | `tests/workspace-e2e/chat-turns-http.e2e.mjs`, `files-reliability-http.e2e.mjs`, `chat-crash-recovery-http.e2e.mjs` (needs a harness that SIGKILLs and restarts the server between `--phase=start` and `--phase=verify`) | retries, concurrent retries, long threads; upload idempotency, real-producer documents incl. PPTX notes and scanned PDF, isolation; server crash and 150 s lease recovery. Not real-provider validation |
| HTTP E2E (Q-14; fake model, SIMULATED) | `tests/workspace-e2e/contracts-q14-http.e2e.mjs` phases `main`, `roles`, `compat` | feature signal and turn codes on q13 / pre-q13 / pre-q12 databases; retry contract; move, dedupe, isolation; role matrix; citations after library changes |
| Unit (Q-14) | `features.test.ts`, `library.test.ts`, `proxy-route-coverage.test.ts` | probe classification (missing relation/column only), 403 vs 404 refusals, route inventory |
| Unit (Q-16) | `turn-send.test.ts` (`withServerTurnId`) | mint / unique / lowercase; passthrough; minted turn stamps the user message and claims the lease |
| HTTP E2E (Q-16; fake model, SIMULATED) | `tests/workspace-e2e/usage-turnless-q16-http.e2e.mjs` (L1–L6, C1, C2, D1); `chat-turns-http.e2e.mjs` check 8 updated | turn-less send / error + retry / stop / timeout / duplicates / agent run each write exactly one usage row per call; client `turnId` unchanged; isolation |

### pgTAP baseline (Q-14, recorded 2026-11-20 on a disposable 128-migration stack)

The authoritative suite is `supabase/tests/database/*.test.sql` (80 files; CI `database-tests`). Q-14 result:
**78 files clean, 2 known environment failures, identical per file to the Q-13 run**, no Q-14 regression.

| File | Result | Classification |
|---|---|---|
| `appointment_requests.test.sql` | test 26 fails (`service_role` holds DELETE: have 2, want 0) | known baseline (environment grants), also on Q-13 |
| `draft_attribution_and_audit.test.sql` | 21 ok, psql exit 3 | known baseline, also on Q-13 |
| `supabase/tests/tool_approvals.test.sql` (**outside** `tests/database`) | 0 ok, 4 not ok, psql exit 3 | **stale template, not a Q-14 regression** (below) |

`tool_approvals.test.sql` origin: added in `8e9dc9d` (2026-11-15, "feat(connect): B-1..B-7", Connect area, not Workspace).
It is a template with literal placeholders (`'<org>'`, `'<conn>'`) and calls the B-7 signatures
`record_tool_approval(uuid,uuid,text,text,int)` / `revoke_tool_approval(uuid,uuid,text,text)`, which
`20261115000008_approval_integrity` dropped and `…000019/20/21` replaced (hence `42883 function does not exist`).
The file is **not on `origin/main`** (there `supabase/tests/` holds only `database/` and `run-local.sh`); it exists only on
the unmerged stack. The approval functions are covered by `tests/database/workspace_approval_requests.test.sql` and
`connect_mcp_privilege_hygiene.test.sql`. Risk: CI keeps race tests in `supabase/race-tests/` precisely because the
`supabase test db --local` scan covers `supabase/tests/`; if the stack is ever merged, this file would likely fail CI.
Owner of the fix: the Connect area (rewrite into `tests/database` or remove), not Workspace. Not changed here.


### Q-16 results (branch `feat/workspace-usage-turnless` on `6bcefb9`; disposable 133-migration stack)

HTTP E2E with the fake model (SIMULATED): q16 9/9 (twice), q15 19/19, q12–q13 12/12. Control on the
unchanged `6bcefb9` build: q16 3/9 (L1–L6 fail, `turnId null`); DB: 7 turn-less user messages, 0 stamped,
**0 usage rows**. Fix: 8 user messages, 8 stamped, **9 rows** (8 turns + 1 retry; succeeded 6, failed 2,
cancelled 1). No migration changed. IT `workspace-api.integration.test.ts` 54/54. pgTAP
`supabase/tests/database`: 85 files, 2,524 ok, 1 not ok, identical TAP lines to the Q-15 baseline (same 2
known environment failures; top-level legacy `tool_approvals` same 4). No new failures.

### pgTAP baseline (Q-15, on RC4 `4b7eac5` + this branch, disposable 133-migration stack)

`supabase/tests/database`: **85 files, 2,524 ok, 1 not ok. 83 files are clean; the 2 known environment
failures are unchanged** (`appointment_requests` test 26; `draft_attribution_and_audit` psql exit 3).
The stale top-level `tool_approvals.test.sql` adds its 4 legacy failures (Connect area, as above).
The IT suite `workspace-api.integration.test.ts` passed 54/54 against real PostgREST + RLS.

Found and fixed in Q-15: **`workspace_approval_requests.test.sql` was already failing on RC4**
(36 ok, then psql exit 3, `permission denied for function claim_tool_approval`). The Connect migration
`20261120000010_mcp_approval_audit` revokes the unaudited `claim_tool_approval` from `authenticated`
on purpose ("no unaudited claim path remains for users"), and test 36 still called it. The test now
claims through `claim_tool_approval_audited(..., 'approved_call')`, as the app does: 40/40. Test only;
no migration changed.

### F-4: edit permission and resulting visibility

`CustomAgent.canEdit` describes an owner save that **preserves current visibility**.
A known non-viewer owner can edit a private agent; an organization-visible agent
also requires organization role `owner` or `admin`, matching `agents_update`
`WITH CHECK`. A demoted `manager`/`agent` owner therefore receives `canEdit:false`
for an organization agent and `403` for a PATCH that leaves it organization-visible
(including omitted `visibility`). Instructions remain redacted when `canEdit` is false.

Ownership is still required: other-owner PATCH is `404`, including for admins.
An explicit owner PATCH to `visibility: private` remains allowed for a non-viewer,
as already permitted by RLS; it is not automatic and does not erase instructions.
Private-to-organization publication still requires owner/admin. Viewer owners
cannot write or delete. Admin moderation deletion remains separate from editing.
Knowledge-link endpoints retain their existing owner/non-viewer policy; their RLS
does not use the resulting-agent-visibility check. The current UI conservatively
hides knowledge editing when `canEdit` is false. No database authorization was widened.
