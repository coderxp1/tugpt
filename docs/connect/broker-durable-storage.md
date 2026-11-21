# Credential broker: from in-memory to durable encrypted storage

Status: **design, not implemented.** Today the broker runs on `InMemoryCredentialStore` (unit tests and the isolated smoke test only). This document is the plan for `PostgresCredentialStore`, which must exist before any staging connection holds a real token.

Related: ADR-021 D3/D5, `packages/credential-broker/src/store.ts` (the contract), migration `20261112000001_connect_registry.sql`, `docs/connect/key-management-evaluation.md`, `docs/connect/key-custody-proposal.md`.

## 1. What changes and what does not

| Concern | In-memory (today) | Postgres (target) |
|---|---|---|
| Contract | `CredentialStore` / `CredentialTx` | **unchanged**: same interface, same service code |
| Ciphertext | JS object | `connected_account_credentials` (iv, ciphertext, auth_tag, key_id, credential_version) |
| Status | field on the row | `connected_accounts.status`, `last_error_code` |
| Per-connection serialization | promise chain | `pg_advisory_xact_lock` inside one transaction |
| Optimistic concurrency | version compare | `UPDATE … WHERE credential_version = $expected` (rowcount = 1) |
| Keys | test key ring | key ring file `/run/secrets/tugpt_keyring`, **never in the database** |
| Survives restart | no | yes: the process is stateless |

A database dump or backup alone is useless to an attacker. It holds AES-256-GCM ciphertext whose AAD binds `tugpt.cred.v2 | organization | connection | provider | kind | version`. A row copied to another organization or connection, or replayed at an older version, fails authentication on decrypt.

## 2. Queries (exact shape)

Every query is keyed by **both** `organization_id` and `connection_id`, so a mismatched pair returns nothing.

```sql
-- load(org, conn)
SELECT ca.provider_key, ca.status, c.kind, c.credential_version, c.key_id,
       c.iv, c.ciphertext, c.auth_tag, c.expires_at
FROM public.connected_accounts ca
LEFT JOIN public.connected_account_credentials c
       ON c.connection_id = ca.id AND c.organization_id = ca.organization_id
WHERE ca.organization_id = $1 AND ca.id = $2 AND ca.revoked_at IS NULL;

-- withConnectionLock(org, conn, fn)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('connect:' || $2::text, 0));
-- fn(tx) runs here: load → (maybe refresh at the vendor) → compareAndSwap
COMMIT;            -- ROLLBACK on any thrown error; the lock is released either way

-- compareAndSwap(org, conn, expected, next)  — existing credentials row
UPDATE public.connected_account_credentials
   SET credential_version = $4, key_id = $5, iv = $6, ciphertext = $7, auth_tag = $8,
       expires_at = $9, updated_at = now()
 WHERE organization_id = $1 AND connection_id = $2 AND credential_version = $3;
-- first credential for a pending connection (expected = 0)
INSERT INTO public.connected_account_credentials (connection_id, organization_id, kind,
       credential_version, key_id, iv, ciphertext, auth_tag, expires_at)
VALUES ($2, $1, $10, 1, $5, $6, $7, $8, $9)
ON CONFLICT (connection_id) DO NOTHING;
-- same transaction: status
UPDATE public.connected_accounts SET status = $11, last_error_code = $12, updated_at = now()
 WHERE organization_id = $1 AND id = $2;
```

`true` is returned only when the credentials statement affected exactly one row. Revoke deletes the credentials row and sets `revoked_at` and `status = 'disconnected'`. A revoked connection is terminal (`connected_accounts_revoked_is_disconnected`), and reconnecting creates a new connection id. Because the AAD includes the connection id, a version that restarts at 1 is safe.

**Why the lock spans the vendor call:** the refresh request to Google happens while the transaction holds the advisory lock. This is what guarantees one refresh per connection, which matters for vendors that rotate refresh tokens (Microsoft does; Google usually doesn't). The cost is one pooled connection per in-flight refresh, for at most about 10 s (refresher timeout). That is bounded by `statement_timeout` and `idle_in_transaction_session_timeout`, and the broker pool is sized separately from the web app (start: 10). A lease column would avoid holding a transaction, but it brings back the failure modes the lock removes (expired leases and double refresh). Revisit only if refresh latency becomes a pool problem.

## 3. Database role

The broker connects as a **dedicated login role `connect_broker`**, not `service_role` and not the web app's credentials. That role will be added in its own migration, with these grants:

| Table | Grants |
|---|---|
| `connected_account_credentials` | SELECT, INSERT, UPDATE, DELETE |
| `connected_accounts` | SELECT; UPDATE (status, last_error_code, updated_at, revoked_at, revoked_by) |
| `credential_access_log` | INSERT only |
| `connection_health_events` | INSERT only |

Then `REVOKE ALL ON public.connected_account_credentials FROM service_role`, so the web app's service key can no longer read ciphertext. This closes the gap that the migration's `service_all` policy leaves open today. The role's password is a Docker secret on the broker host only, issued through the secret store; it is never pasted or logged.

## 4. Restart and recovery

The process is stateless. All durable state lives in Postgres, and key material in the mounted key ring.

**Startup sequence (fail closed):**
1. Load and parse the key ring. If it is missing, unreadable, mode wider than `0400`, empty, or has no active key, the broker **exits non-zero**.
2. `SELECT DISTINCT key_id FROM connected_account_credentials`. If any `key_id` is not in the ring, the broker stays **not ready**: readiness fails, it accepts no requests, and it emits the alert `CONNECT_KEY_MISSING`. It never deletes or re-encrypts rows on its own.
3. Decrypt-test one row per `key_id` (canary). Only the result is recorded, never the plaintext.
4. Mark ready.

**Crash at each point of a refresh:**

| Crash point | State afterwards | Effect |
|---|---|---|
| Before the vendor call | transaction rolled back, lock released by session end | next call refreshes normally |
| After the vendor responded, before commit | old version remains | **Google:** old refresh token still valid, next call refreshes again. **Rotating vendors:** the old refresh token may be invalid. The next refresh then gets `invalid_grant`, the connection becomes `requires_authorization`, and the user sees a reconnect prompt. No silent data loss, and never a token that isn't persisted. |
| After commit, before the response is sent | new version stored | caller retries; it gets the stored token with no second vendor call |

Advisory transaction locks are released by Postgres when the session ends, so a crashed broker never leaves a stuck lock.

## 5. Failure handling

| Failure | Broker outcome (`credential_access_log.outcome`/`detail`) | Runtime sees | Notes |
|---|---|---|---|
| Postgres unreachable or lock timeout | `error` / `DB_UNAVAILABLE`, HTTP 503 | `PROVIDER_UNAVAILABLE` | **No fallback** to memory or cache. Bounded retry with jitter, client side only. |
| Decrypt fails (GCM tag mismatch) | `error` / `CREDENTIAL_INTEGRITY`; status `error` | `CONNECTION_NOT_ACTIVE` | Page on-call. It means tampering, a wrong key or AAD drift. Never retried. |
| `key_id` not in ring | `error` / `UNKNOWN_KEY_ID` | `CONNECTION_NOT_ACTIVE` | Same alert as startup check 2. |
| Vendor 400 `invalid_grant` | `refresh_failed` / `REQUIRES_AUTHORIZATION`; status `requires_authorization` | `REAUTHORIZATION_REQUIRED` | Already implemented and tested. |
| Vendor 5xx or timeout | `refresh_failed` / `REFRESH_FAILED`; status unchanged | `PROVIDER_UNAVAILABLE` | Already implemented. Backoff happens in the worker job, not the broker. |
| Version conflict (someone else refreshed) | `ok` | token | Reload and use the winner's token. Already implemented: no second vendor call. |
| Persist fails after a successful refresh | `persist_failed` / `PERSIST_FAILED` | `PROVIDER_UNAVAILABLE` | The token is **not returned**. Already implemented. |
| Audit insert fails | operation fails, `error` / `AUDIT_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` | No unaudited token release. Same transaction as the CAS, where possible. |
| Nonce collision (`(key_id, iv)` unique) | CAS fails, then retried once with a fresh IV | — | Astronomically unlikely; the index makes reuse impossible to store. |

## 6. Test plan (must pass before staging holds a real token)

1. **Shared contract suite:** the existing store tests are factored into `describeCredentialStore(factory)` and run against both `InMemoryCredentialStore` and `PostgresCredentialStore`.
2. **Integration**, against the isolated Supabase stack (`tugpt-connect-p0`, two organizations):
   - cross-org `load` returns null
   - 20 parallel `get_access_token` calls on an expired token trigger **exactly one** refresher call (counted by a fake refresher)
   - a lock-timeout path
   - CAS conflict
   - first-credential insert
   - revoke deletes the ciphertext and keeps the audit history
3. **Crash tests:** kill the broker container between "vendor responded" and commit, using a fault-injection refresher that blocks. Assert the version is unchanged and the next call recovers.
4. **Restart test:** restart the container, and the same connection's token is served without a vendor call.
5. **Startup fail-closed tests:** the broker refuses to start, or stays not ready, when:
   - the ring is missing
   - the ring has the wrong mode
   - a ring key is absent for a stored `key_id`
   - the canary decrypt fails
6. **Privilege tests (pgTAP):**
   - `connect_broker` cannot read other tables
   - `service_role` can no longer `SELECT` from `connected_account_credentials`
   - `authenticated` has no access at all (already tested)
7. **Separation guard:** adding the Postgres client (`pg`) is the broker's first runtime dependency. It is a reviewed change to `ALLOWED_DEPENDENCIES` in `packages/credential-broker/src/separation.test.ts`, and that test fails until the change is made deliberately.


## Static MCP bearer credentials (B2, migration 20261120000013)

**Status:** implemented on branch `agent2/mcp-authenticated-customer`; verified against the isolated harness database only. Not deployed.

- A customer MCP endpoint that needs a static bearer token or API key references a `connected_accounts` row with `provider_key = 'mcp_custom'` and `credential_kind = 'mcp_static_bearer'` through `external_tool_endpoints.auth_connection_id` (composite FK with `organization_id`, so endpoint and credential always belong to one organization).
- The CHECK `connected_accounts_mcp_custom_kind` binds provider and kind both ways and requires organization ownership.
- The broker encrypts `{ "v": 1, "secret": ... }` with AES-256-GCM. The AAD covers organization, connection, provider, kind and credential version, so ciphertext copied to another connection does not decrypt.
- Secrets must be visible ASCII, 8 to 4096 characters (no space, CR or LF, so they can't inject a header). Storing again rotates (version + 1). Revocation is terminal.
- Capabilities: `web` may call `store_static_secret` (`POST /v1/static-secret`) and never read a secret back. Only `worker` may call `get_static_secret` (`POST /v1/static-secret/read`). Static and OAuth kinds never mix: `getAccessToken` on a static connection and `getStaticSecret` on an OAuth connection both return `BAD_REQUEST`.
- Tests: `packages/credential-broker/src/static-secret.test.ts` (in-memory, HTTP and Postgres) and `supabase/tests/database/connect_mcp_static_credential.test.sql`.
