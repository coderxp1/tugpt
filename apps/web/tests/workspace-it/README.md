# Workspace API integration tests

`src/lib/workspace-data/workspace-api.integration.test.ts` drives the real
route handlers against **real PostgREST + Postgres**, with one HS256 JWT per
test user, so every RLS policy, grant and RPC in 20261119100001..04 and
20261120100001..05 is exercised exactly as in production. Only `chatContext` (session + tenant
resolution, tested elsewhere) is replaced: it returns the user's PostgREST
client and the tenant the test chooses, including a *forged* tenant to prove
the database rejects it on its own.

The suite is skipped unless `WS_IT_POSTGREST_URL` is set, so normal
`vitest run` stays hermetic and reports it as skipped.

Run against a DISPOSABLE database (never shared/preview/production):

1. Apply all migrations to the database.
2. `psql -v ON_ERROR_STOP=1 -f apps/web/tests/workspace-it/fixtures.sql`
3. Start PostgREST for it (`PGRST_DB_SCHEMAS=public`, `PGRST_DB_ANON_ROLE=anon`,
   `PGRST_JWT_SECRET=<random>`).
4. From `apps/web`:
   `WS_IT_POSTGREST_URL=http://127.0.0.1:<port> WS_IT_JWT_SECRET_FILE=<file with the secret> npx vitest run src/lib/workspace-data/workspace-api.integration.test.ts`

The fixtures are idempotent: re-running step 2 deletes both test
organizations (cascade) and recreates them.

What else runs in-process (no network beyond loopback):

- **Knowledge worker:** `runKnowledgeBatch` from `apps/worker` with a
  `service_role` JWT (same secret), the same filesystem blob store as the
  routes and the real pdfjs extractor, so 202 → pending → ready/failed is
  tested end to end, including FILE_MISSING and a simulated storage outage
  (backoff). `authenticator` must be a member of `service_role`.
- **Server-authored chat writes (Q-9c):** `createSsoControlClient` is replaced
  by a PostgREST client with an `sso_control` JWT (same secret). It is used for
  `append_chat_message_server` and `custom_agent_run_instructions`. As in
  production, `authenticator` must be a member of `sso_control`
  (`GRANT sso_control TO authenticator;` on the disposable test database).
  The suite fails fast with that hint when the membership is missing.
- **Fake embeddings server** on 127.0.0.1 (hashed character trigrams, 64
  dims). It makes semantic/hybrid ranking deterministic; it says nothing
  about the quality of a real embedding model.
- **Fake LLM** on 127.0.0.1 (OpenAI-compatible SSE). The test sets
  `TUGPT_PRIVATE_LLM_URL` to it and records every request body, so the agent
  system prompt, history and model selection are asserted exactly.

`fixtures.sql` also clears the rate-limit buckets of both test organizations,
so the suite can be re-run back to back.

