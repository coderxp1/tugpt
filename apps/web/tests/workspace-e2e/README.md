# Conversations over real HTTP (no mocks)

`conversations-http.e2e.mjs` calls a running `next start` exactly like a browser
would. A request passes through:

1. `proxy.ts`, which loads the session from the `__Host-tugpt_session` cookie
   via `sso.load_session` (`sso_control` RS256 bridge token);
2. the route handler, which uses `createAuthenticatedServerClient` (an
   `authenticated` RS256 bridge token bound to the session hash);
3. the dashboard PostgREST, which verifies the token against a JWKS
   (`aud=tugpt-dashboard-db`) and runs `sso.pre_request`;
4. Postgres RLS.

It covers listing, search (title and message), rename, archive and restore,
folders, and delete. It also covers revoked, garbage and missing sessions,
forged tenant hints, CSRF and origin checks, and other users in the same
organization and in another one.

## Setup (DISPOSABLE database only)

1. Apply all migrations, then load `../workspace-it/fixtures.sql`.
2. Generate cookie values (`randomBytes(32).toString('base64url')`) for
   ownerA, memberA, viewerA, ownerB and revoked. Run `sessions.sql` with the
   **SHA-256 hex hashes** as `-v h_owner_a=… -v h_member_a=… -v h_viewer_a=… -v h_owner_b=… -v h_revoked=…`.
3. `GRANT sso_control TO authenticator;` (deployment prerequisite: the
   dashboard PostgREST must be able to switch to `sso_control`).
4. Generate an RSA key pair. Start PostgREST with
   `PGRST_JWT_SECRET=<JWKS containing the public key, with a kid>`,
   `PGRST_JWT_AUD=tugpt-dashboard-db`, `PGRST_DB_SCHEMAS=public,sso`,
   `PGRST_DB_PRE_REQUEST=sso.pre_request` and `PGRST_DB_ANON_ROLE=anon`.
5. `next build`, then `next start` with `TUGPT_DASHBOARD_POSTGREST_URL=http://127.0.0.1:<rest>/`,
   `TUGPT_DB_SIGNING_KID=<kid>`, `TUGPT_DB_SIGNING_PRIVATE_KEY=<PEM>` and
   `TUGPT_APP_ORIGIN=https://<origin>`. It must be HTTPS: the app refuses any
   other origin and every mutation fails closed with 403.
6. `E2E_BASE_URL=http://127.0.0.1:<port> E2E_ORIGIN=https://<origin> E2E_COOKIES_FILE=<json> node tests/workspace-e2e/conversations-http.e2e.mjs`

The cookie file and the private key are secrets: keep them `0600` outside the
repository, and never log them.

# Library upload over real HTTP (Q-8)

`library-upload-http.e2e.mjs` uses the same `next start`, cookies and bridge,
plus the **real knowledge worker** (`apps/worker/dist/knowledge-index.js`).
It checks that:

- adding an uploaded file returns `202` with a `pending` document (no inline
  indexing, no `403`), and the document is not searchable while pending;
- a retry with the same file, or a re-upload of the same bytes under a new file
  id, returns `200` with `created:false` and the existing document (no
  duplicates);
- another tenant gets `404`, a forged tenant hint gets `403`, a viewer or
  another user in the same organization gets `404`, and no session gets `401`;
- the worker moves the document `pending → ready`, after which search finds
  it; a file it cannot extract ends `failed` / `EXTRACTION_FAILED`.

The runner spawns the worker only after the pending checks, so they cannot
race. It passes its own environment to the worker.

Additional setup:

7. `next start` and the runner both need `TUGPT_FILE_STORAGE=fs` and the same
   absolute `TUGPT_FILE_STORAGE_DIR` (use a temporary directory).
8. The worker needs `SUPABASE_SERVICE_ROLE_KEY` (a short-lived HS256
   `role=service_role` token for a PostgREST **without** `sso.pre_request`) and
   `NEXT_PUBLIC_SUPABASE_URL`, which must serve PostgREST under `/rest/v1/` like
   Supabase. A small path-rewriting proxy is enough locally.
9. `E2E_WORKER_ENTRY=<abs path to knowledge-index.js> … node tests/workspace-e2e/library-upload-http.e2e.mjs`

The service-role token is a secret: keep it in process memory only.

A storage write failure (`503 STORAGE_UNAVAILABLE`, no file row) is covered by
the route integration test, not over HTTP.

# Server-client signing path over real HTTP (Q-10)

`chat-signing-http.e2e.mjs` covers what the other runners never do: answers
that the **server** writes and reads with its own RS256 `sso_control` bridge
token (`createSsoControlClient`). That token goes through PostgREST and
`sso.pre_request` to `SET ROLE sso_control`, and then to the Q-9c functions.
The model is `fake-llm.mjs`, a loopback OpenAI-compatible endpoint that logs
what the app sent it. No real model or key is involved.

With `E2E_EXPECT=granted` (default) it checks that:

- a plain chat answer is stored (`append_chat_message_server`) and shows up on
  reload;
- the owner of an organization agent sees its instructions, and a member who
  cannot edit it sees `''` in both get and list;
- when that member runs the agent, the instructions reach the model's system
  prompt in `<agent_instructions>` (`custom_agent_run_instructions`), never
  the stream or the thread;
- no response body contains a JWT.

With `E2E_EXPECT=revoked`, `authenticator` is **not** a member of `sso_control`.
Sessions cannot load, so every protected request must be
`503 {"error":"temporarily_unavailable"}` and the model must never be called.
The harness separately checks that no row was written.

Additional setup on top of the conversations setup above:

1. `FAKE_LLM_PORT=<port> FAKE_LLM_LOG=<file> node tests/workspace-e2e/fake-llm.mjs`
2. Also start `next start` with `TUGPT_PRIVATE_LLM_URL=http://127.0.0.1:<port>/v1`
   (plain `http` is accepted on loopback only).
3. `FAKE_LLM_LOG=<file> E2E_EXPECT=granted node tests/workspace-e2e/chat-signing-http.e2e.mjs`
4. Optional negative phase, **disposable database only**:
   `REVOKE sso_control FROM authenticator`, run with `E2E_EXPECT=revoked`,
   then `GRANT sso_control TO authenticator` and run `granted` again.

The runner works on databases with and without the Q-9c migrations. On an
older database the app uses its pre-Q-9c fallbacks (docs/workspace/operations.md §1a).
