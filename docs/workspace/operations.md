# Workspace operations notes (Q-6/Q-7/Q-8)

Scope: what an operator must configure or know to run the workspace features
(chat threads, library, custom agents) safely. Values verified on a fresh
database built from the 113 committed migrations (latest `20261120100010`).

## 1. Deploy order

1. Apply migrations **before** deploying the app. The app calls
   `link_custom_agent_collection` (100009) and the 8-argument
   `search_chat_threads` (100007); an old database returns 404/500 for those.
   Since Q-9 the app selects `chat_messages.citations` / `knowledge_unavailable`
   (100010) on every thread read: deploying the app before 100010 makes
   PostgREST reject those selects (unknown column), so thread reads and sends
   fail (status code not separately verified). 100010 is additive (two
   NOT NULL columns with constant defaults, two CHECKs), so it is safe to apply
   while the old app runs.
2. Deploy web and worker together; the worker writes chunks the web reads.
3. Migrations are frozen once committed; checksums live in
   `supabase/migrations/checksums.json`.

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
