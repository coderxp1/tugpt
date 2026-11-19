# Workspace API integration tests

`src/lib/workspace-data/workspace-api.integration.test.ts` drives the real
route handlers against **real PostgREST + Postgres**, with one HS256 JWT per
test user, so every RLS policy, grant and RPC in 20261119100001..04 is
exercised exactly as in production. Only `chatContext` (session + tenant
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
