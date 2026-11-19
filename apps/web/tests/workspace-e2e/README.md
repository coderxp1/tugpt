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
