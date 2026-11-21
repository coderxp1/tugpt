# Workspace operations notes (Q-6/Q-7/Q-8)

Scope: what an operator must configure or know to run the workspace features
(chat threads, library, custom agents) safely. Values verified on a fresh
database built from the 114 committed migrations (latest `20261120100011`).

## 1. Deploy order

1. Apply migrations **before** deploying the app (exception: Q-9c, app first,
   see §1a). The app calls
   `link_custom_agent_collection` (100009) and the 8-argument
   `search_chat_threads` (100007); an old database returns 404/500 for those.
   Since Q-9 the app selects `chat_messages.citations` / `knowledge_unavailable`
   (100010) on every thread read: deploying the app before 100010 makes
   PostgREST reject those selects (unknown column), so thread reads and sends
   fail (status code not separately verified). 100010 is additive (two
   NOT NULL columns with constant defaults, two CHECKs), so it is safe to apply
   while the old app runs.
   100011 (Q-9b) replaces the citation validator and re-validates every
   `chat_messages` row: it holds an ACCESS EXCLUSIVE lock on `chat_messages`
   for one full scan, and it **aborts and rolls back** if any stored row has
   malformed citations (error `check constraint "chat_messages_citations_valid"
   ... is violated by some row`). Nothing is repaired automatically. Apply 100010
   and 100011 together; if 100010 was ever live on its own, look for rows with
   `NOT private.valid_message_citations(citations)` before applying 100011 and
   decide on them explicitly (they can only be a user's own assistant rows). The
   app needs no change for 100011.
   **Q-9c (200001–200003): deploy the app first, then the migrations.** See
   §1a. Since Q-10 the app works on both schemas, so no step of the
   rollout leaves a broken app. The migrations are DDL/grant changes only (no table rewrite and no
   row scan). Each takes a brief ACCESS EXCLUSIVE lock for its
   `REVOKE`/`GRANT`/policy change.
   **B-1 (ordering with Agent 2's MCP migrations):** Agent 2's
   `20261120000001`–`000006` (`agent2/m9-followup`, `47ea476`) sort *between*
   this tree's `20261119100004` and `20261120100001`. The Supabase CLI refuses
   local migrations older than the remote's latest without `--include-all`
   (docs/server-migrations.md §6). Agent 2's six still
   have to land on `main` and be applied **before** 20261120100001+ reach a
   database, or else be renumbered by Agent 2. That decision is Agent 2's and
   is still open.
   Scratch check (not committed; this tree plus Agent 2's six migrations and
   four pgTAP files from `47ea476`), with the same results in both orders:
   - Fresh database in sorted order: 123 migrations applied.
   - Agent 2's six applied by psql *after* all 117 of this tree, the order
     `--include-all` would produce.
   - In both, pgTAP gave 75 files, 2223 ok. The only failures were the
     pre-existing `appointment_requests` #26 and the `draft_attribution_and_audit`
     `schema_migrations` error. `table_privilege_hygiene` H1–H3 pass once Agent 2's
     000001 is present.
   - The two sets touch no common object. Agent 2 should still confirm the order
     on their side.
   **B-2 (open, blocks combining the branches): duplicate version
   `20261120200001`.** Since `644ce7b` (2026-11-20 03:41 UTC),
   `agent2/m9-followup` adds `20261120200001_mcp_snapshot_legacy_revoke_owner_first.sql`.
   This tree's committed, frozen Q-9c migration is
   `20261120200001_workspace_agent_instructions_confidential.sql`.
   `supabase_migrations.schema_migrations` is keyed by the bare version
   (docs/server-migrations.md), so only one of the two can be recorded. The
   CLI is expected to treat the other as already applied and never run it.
   That is inferred from the ledger key; it was not run with the CLI here.
   - If the Q-9c file is the one skipped, agents lose instruction
     confidentiality (F-1), and the app falls back to its pre-Q-9c path.
   - If Agent 2's file is the one skipped, its revoke is missing.
   Neither failure is loud. Resolution: Agent 2 renumbers their file to a free
   version after `20261120200003` before either set reaches a shared
   database. This tree's IDs cannot change (frozen). Guards:
   - `apps/worker/tests/migration-versions.test.ts` fails on any duplicate
     version (verified: it fails with both file names when Agent 2's file is
     added to this tree);
   - `deploy/workspace-q9c-preflight.sql phase=after` fails if 200001 was
     skipped (2/4 functions present: partial).
2. Deploy web and worker together; the worker writes chunks the web reads.
3. Migrations are frozen once committed; checksums live in
   `supabase/migrations/checksums.json`.

## 1a. Q-9c rollout (expand/contract, Q-10)

### Measured compatibility

Integration suite (`workspace-api.integration.test.ts`, 52 tests, real
PostgREST and RLS) on disposable stacks. "Old schema" is 114 migrations (up
to `20261120100011`); "Q-9c schema" is 117 (up to `20261120200003`).

| App \ database | old schema | Q-9c schema |
|---|---|---|
| app before Q-9c (`e288687`) | 51/51 pass | **19 fail**: `GET /chat/threads/{id}` is 403 for *every* thread (the old app selects `citations`, 42501); agent list/get/create; every chat answer; agent runs |
| Q-9c app without Q-10 (`ae76208`) | **18 fail** (probe removed to measure): agent create/get 503 (missing function, `PGRST202`); assistant messages not stored; agent runs; thread reads with assistant messages | 52/52 pass |
| **this app (Q-10)** | 51 pass, 1 skipped (`WS_IT_EXPECT_SCHEMA=pre-q9c`; the skipped test asserts Q-9c database grants) | 52/52 pass |

Real RS256 signing over HTTP (`next start` with a throwaway signing key,
`tests/workspace-e2e/chat-signing-http.e2e.mjs`, fake model) passed on both
schemas: a plain chat answer is stored, the owner sees agent instructions, a
non-owner sees `''`, an agent run puts the instructions in the model prompt
and never in a response, and no response body contains a JWT.

### Why the Q-10 app is safe on both schemas

Each of the four Q-9c functions is tried first. Only when PostgREST answers
`PGRST202` (the function does not exist) does the app run the pre-Q-9c query
instead (`apps/web/src/lib/supabase/schema-compat.ts`):

| Function | Fallback (old schema only) |
|---|---|
| `custom_agent_instructions` | `select id,instructions` with the user's token, only for agents the caller can edit |
| `custom_agent_run_instructions` | `select instructions` with the user's token (RLS) |
| `chat_message_citations` | `select id,citations` with the user's token; then the same per-document `authorizeCitations` as before |
| `append_chat_message_server` | the old full insert with the user's token |

- On a Q-9c database the functions exist, so a fallback is unreachable.
- On an old database a fallback does only what that database already allows
  the caller.
- `42501` and every other error still fail closed. Unit tests cover this:
  `store.test.ts` and `agents-compat.test.ts`.

### Prerequisites (all deployments)

- `authenticator` must be a member of `sso_control`, and the app's
  `TUGPT_DB_SIGNING_KID` / `TUGPT_DB_SIGNING_PRIVATE_KEY` must match the JWKS
  PostgREST trusts (`PGRST_JWT_AUD=tugpt-dashboard-db`,
  `PGRST_DB_PRE_REQUEST=sso.pre_request`). This is **not new with Q-9c**: every
  protected request already loads its session through `sso.load_session` with
  that same `sso_control` token (`proxy.ts`). Measured with the membership
  revoked: every protected request returns `503 {"error":"temporarily_unavailable"}`,
  the model is never called, and no row is written. So a deployment where
  users can sign in today already meets this.
- No new secret, environment variable, or PostgREST setting.

### Sequence

1. Deploy this web build on the **old** schema, together with the worker
   (§1.2). Smoke test: sign in, open a thread with an answer, send one message,
   open an agent you own and one you do not, run an agent.
2. `psql -X -v ON_ERROR_STOP=1 -v phase=before -f deploy/workspace-q9c-preflight.sql`
   must pass. It is read-only (catalog metadata only). It fails on a partial
   Q-9c set or a missing `sso_control` membership.
3. Apply `20261120200001`–`200003` (B-1 above still applies to the
   `20261120000001`–`000006` / `20261120100001+` ordering, not to these three).
4. `psql -X -v ON_ERROR_STOP=1 -v phase=after -f deploy/workspace-q9c-preflight.sql`
   must pass: functions present, EXECUTE only where intended, the
   `instructions`/`citations` reads and the assistant INSERT closed to
   `authenticated`, and the INSERT policy only admits `role = 'user'`.
5. Repeat the smoke test from step 1.

### Rollback

- **Before step 3:** roll back the app freely. The old schema works with both
  the old app and this one.
- **After step 3:** the rollback target is **this app (or later), never an app
  before Q-9c**. An app before Q-9c on a Q-9c database returns 403 on every
  thread read (table above).
- **Do not reverse the migrations.** There is no down-migration, by design:
  re-granting the column reads or the old INSERT policy reopens Q-9c F-1..F-3.
  Fix forward.

### Contract step (later)

Once every environment passes step 4, remove the fallbacks in a follow-up
change: `schema-compat.ts`, its four call sites, the `legacy` parameter of
`appendServerMessage`, `WS_IT_EXPECT_SCHEMA`, and `agents-compat.test.ts`.
After that, the app again requires the Q-9c schema.

## 1b. Q-12 chat turns rollout (`20261121100001`, additive)

**Order: migration, then app.** Both mixed states were measured on disposable stacks:

| App | Database | Result |
|---|---|---|
| Q-11 app (before Q-12) | with `20261121100001` | IT suite 54/54. The old app never touches `turn_id`; existing grants and `append_chat_message_server` are unchanged. |
| Q-12 app | with `20261121100001` | IT 54/54, HTTP turn runner 10/10 |
| Q-12 app | without it (124 migrations) | turn-less sends unchanged (signing e2e 14/14). A send *with* `turnId` degrades to a turn-less send: `200`, `turnId: null` in the events, no de-duplication (two identical sends both get `200`). `GET .../turns/{id}` answers 404. No 5xx in the HTTP turn runner (2/10 pass by design: turn-less sends and isolation). Reads fall back on `42703`, inserts on `PGRST204` (`schema-compat.ts`, `isMissingColumn`). |

There is nothing to back-fill: existing messages keep `turn_id = NULL`.

**Rollback:** roll back the app first. The column, indexes and the new function can stay; the old app
ignores them. Dropping them would need a new forward migration; do not edit `20261121100001`.

## 1c. Q-13 reliability rollout (`20261122100001`, `20261122100002`, additive)

**Order: migrations, then app.** Both migrations only add a table, a nullable column, an index and
server-only functions; nothing existing changes.

Measured on fresh disposable stacks (fake model, real PostgREST + RLS, real knowledge worker):

| App | Database | Result |
|---|---|---|
| Q-12 app (`550e157`) | with both Q-13 migrations (127) | IT suite 54/54; Q-12 HTTP turn runner 10/10. The old app never reads `chat_turn_runs` or `upload_request_id`. |
| Q-13 app | with both (127) | IT 54/54; HTTP turn runner 12/12; files runner 7/7 (`Retry-After: 2` on every `UPLOAD_IN_PROGRESS`) |
| Q-13 app | without them (Q-12 schema, 125) | IT 54/54; turn runner 11/12; files runner 3/7 (run with `E2E_EXPECT_UPLOAD_IDEMPOTENCY=0`). The failures are exactly the Q-13 guarantees: two concurrent retries both run (`200, 200`, the Q-12 behaviour) and `Idempotency-Key` is ignored (every upload `201`). Turn-less and Q-12 turn flows, the latest-400 thread read, document processing incl. PPTX, and isolation all pass. Failing assertions got 200/201, never a 5xx. Fallbacks: `isMissingTable` for `chat_turn_runs`, `42703` / `PGRST204` for `upload_request_id`. |

The column is `upload_request_id`, not `*_key`: `workspace_files.test.sql` asserts that no
`workspace_files` column matches `key|path|url|bucket`, so storage locators can never be stored.

**Mixed versions:** a Q-12 app instance does not claim leases. While Q-12 and Q-13 instances serve the same
tenant during a rolling deploy, two concurrent retries routed to *different* versions can still both run
(the Q-12 behaviour). Finish the rollout before relying on single-run retries.

**Rollback:** roll back the app first; the table, column and functions can stay. A leftover lease expires
after 150 s. Dropping anything needs a new forward migration.

## 2. Database grants (verified with `has_function_privilege`)

| Function | authenticated | anon | service_role |
|---|---|---|---|
| `save_custom_agent(uuid,uuid,jsonb,uuid[])` | EXECUTE | – | – |
| `link_custom_agent_collection(uuid,uuid,uuid)` | EXECUTE | no | – |
| `search_chat_threads(uuid,text,boolean,uuid,boolean,integer,timestamptz,uuid)` | EXECUTE | no | – |
| `replace_document_chunks(uuid,uuid,text,text[],text)` | **no** | no | EXECUTE |

- `private.can_edit_agent` is `SECURITY DEFINER`, `search_path=pg_catalog`.
  It is used by `agents_update`, `agent_collections_insert`,
  `agent_collections_delete`. `agents_delete` keeps `can_write_agent`
  (owner, or org owner/admin for org agents) by design.
- `link_custom_agent_collection` is `SECURITY INVOKER` (RLS applies).
- The PostgREST login role must be a member of `sso_control`:
  `GRANT sso_control TO authenticator;` (the SSO pre-request hook depends on it).
  Since Q-9c **chat itself** depends on it as well: every assistant/tool message
  is written through `append_chat_message_server`, and every agent run reads its
  instructions through `custom_agent_run_instructions`. Both are executable
  only by `sso_control` and `service_role`. Without the membership, every chat
  answer fails with `STORE_UNAVAILABLE` and agent runs fail before streaming.
- Q-9c functions (all `SECURITY DEFINER`, `search_path=pg_catalog`, no PUBLIC/anon):
  `custom_agent_instructions` and `chat_message_citations` are executable by
  authenticated (they return only what the caller may see).
  `custom_agent_run_instructions` and `append_chat_message_server` are
  executable by `sso_control` and `service_role` only.

## 3. HTTPS origin (`TUGPT_APP_ORIGIN`)

- Must be an exact HTTPS origin, e.g. `https://dashboard.example.com` – no path,
  no trailing slash, no credentials. Forwarded headers are never trusted.
- If it is missing or not HTTPS, every browser mutation (POST/PATCH/DELETE)
  is rejected with **403**, because the same-origin check fails closed.
- Mutations also need `Origin` == that value, `x-tugpt-csrf: 1`,
  `Content-Type: application/json`, and `Sec-Fetch-Site` not `cross-site`.

## 4. Worker configuration

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | PostgREST base ending in `/rest/v1/` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role JWT from the secret store (never in logs or the repo). The worker talks to PostgREST as service_role, which skips `sso.pre_request`. |
| `TUGPT_FILE_STORAGE`, `TUGPT_FILE_STORAGE_DIR` | **identical** to the web app, or the worker cannot read uploads |

The worker exits with a clear message if the URL or key is missing.

## 5. Rate limits (`private.workspace_rate_limit_policies`)

Per user, per organisation, fixed window. Excess returns **429 `RATE_LIMITED`** with `Retry-After`.

| Action | Max | Window | Used by |
|---|---|---|---|
| `file.upload` | 60 | 1 h | `POST /files` |
| `document.reindex` | 60 | 1 h | add document to a collection, reindex |
| `agent.write` | 60 | 1 h | agent create/update/delete, link/unlink |
| `agent.run` | 30 | 1 min | agent runs |
| `library.search` | 120 | 1 min | `GET /library/search` |

## 6. Integration test suite needs a fresh database

`workspace-api.integration.test.ts` assumes the state from
`apps/web/tests/workspace-it/fixtures.sql`, which also clears the rate-limit
windows. A second run without a reload fails (leftover rows, `agent.run` 429).
Since `8ffd5b6` the suite checks this in `beforeAll` and stops with
"Integration database is not fresh … Reload …fixtures.sql". Reload the
fixtures before every run.

## 7. Thread pagination index – no change needed

Measured with 200k threads for one user (20-way `updated_at` ties, 100k noise
rows), cursor 150k rows deep, inside a rolled-back transaction:

| Case | Result |
|---|---|
| `search_chat_threads` through the function, calls 1–9 | 12.5 ms (auto_explain on), then 1.8–3.1 ms; flat after the 5-call plan-cache switch; same with JIT off |
| Plan inside the function | `chat_threads_owner_recent`, cursor bound is an index condition, 8 rows filtered |
| Same SQL forced to a **generic** plan | 27 ms; whole OR'd cursor predicate is a filter, 150,011 rows removed |
| Candidate `(org, owner, updated_at DESC, id DESC)` index, generic plan | 64 ms (worse, 150k heap fetches) |

Conclusion: the existing index is enough. The theoretical risk is a generic
plan (e.g. `plan_cache_mode=force_generic_plan`); a new index does not fix
that. If it ever shows up, split the cursor predicate into separate branches in
a new migration instead of adding an index.
