# Google credential: current storage, new format, migration, rollback, verification

**Owner constraint (2026-11-12):** the production Google credential must not be
re-encrypted, rotated, deleted, or migrated. This document is the prerequisite.
The production migration needs a **separate approval**. Nothing here has been
executed against production.

## 1. Which "Google credential"? Inventory first

The repository uses four distinct Google secrets. Production contents were not
inspected. The operator runs the read-only, metadata-only query in §1.1 to
confirm which ones exist.

| # | Secret | Table / location | Identity (AAD v1) | Written by | Read by |
|---|---|---|---|---|---|
| G1 | TuGPT's Google OAuth **client** `{"client_id","client_secret"}` | `platform_secrets` | `'' ␟ google ␟ oauth_client` | secrets CLI (operator) | web (consent URL, code exchange), worker (refresh) |
| G2 | OAuth **state HMAC secret** | `platform_secrets` | `'' ␟ google ␟ oauth_state_secret` | secrets CLI | web (start/callback) |
| G3 | Per-org Calendar credential `{"access_token","refresh_token","expires_at"}`, scope `calendar.freebusy` | `organization_secrets` | `<org_id> ␟ google ␟ calendar_oauth` | web (callback) and worker (refresh write-back) | worker (free/busy) |
| G4 | Supabase Auth "Sign in with Google" client | Supabase project Auth settings (**not** our vault) | n/a | Supabase dashboard | Supabase Auth |

G4 is out of scope: it is not in our vault, and nothing in Connect touches it.

### 1.1 Read-only inventory (no ciphertext selected)

```sql
-- Run with a read-only role. Returns metadata only.
select 'platform' as scope, null::uuid as organization_id, provider, secret_name,
       key_id, created_at, updated_at, null::text[] as scopes, null::timestamptz as expires_at
  from public.platform_secrets where provider = 'google'
union all
select 'organization', organization_id, provider, secret_name,
       key_id, created_at, updated_at, scopes, expires_at
  from public.organization_secrets where provider = 'google'
order by scope, organization_id nulls first;
```

## 2. Current encryption path (v1)

- **Encrypt.** `encryptSecret(plaintext, {organizationId, provider, secretName},
  keyId, ring)` performs AES-256-GCM with a random 12-byte IV, a 16-byte tag,
  and AAD = identity joined with 0x1F.
- **Columns.** `algorithm='aes-256-gcm'`, `key_id`, `iv`, `ciphertext`,
  `auth_tag` (bytea). There is `UNIQUE(key_id, iv)` and
  `UNIQUE(organization_id, provider, secret_name)`.
- **Key ring.** It comes from `TUGPT_SECRET_KEY_<ID>`. Platform rows use
  `platform.v1`; org rows use the id in `TUGPT_SECRET_WRITE_KEY_ID` at write
  time (`org.v1` per `.env.example`). The ring is in `/etc/tugpt/worker.env`,
  and the web process needs it too for G1/G2/G3 (see the key-management
  evaluation).
- **Refresh.** The worker refreshes G3 and writes it back best-effort
  (`.catch(() => undefined)`), without a lock.

## 3. New format (v2, credential broker)

| Aspect | v1 | v2 |
|---|---|---|
| Row | `organization_secrets(org, provider, secret_name)` | `connected_account_credentials(connection_id, organization_id, kind, credential_version)` |
| AAD | `org ␟ provider ␟ secret_name` | `tugpt.cred.v2 ␟ org ␟ connection_id ␟ provider ␟ kind ␟ credential_version` |
| Cardinality | 1 per provider per org | many connections, org- or user-owned |
| Who decrypts | web + worker | broker only |
| Refresh | unlocked, best-effort persist | advisory lock + CAS + mandatory persist |
| Platform secrets (G1, G2) | `platform_secrets` v1 | **unchanged.** They stay in `platform_secrets` v1 and are read by the broker. They are application credentials and need no connection binding. |

## 4. Migration procedure (G3 only; G1/G2 are not migrated)

It is **copy-forward and non-destructive**. The v1 row is never modified or
deleted by the migration.

1. **Preconditions.**
   - Broker deployed with the *same* key ring entries that encrypted G3
     (verified by key ids from §1.1, never by printing keys).
   - Registry migration applied.
   - Feature flag `connect_google_v2_read` off.
2. **Backfill job** (broker, one transaction per org):
   1. Read the v1 row and decrypt it with the v1 AAD.
   2. Create the `connected_accounts` row (`owner_type='organization'`,
      `provider='google'`, `scopes` from v1, `status='connected'`,
      `legacy_secret_id = v1.id`).
   3. Encrypt with the v2 AAD under the current write key and insert
      `credential_version = 1`.
   4. **Self-check:** decrypt the new row and compare it to the v1 plaintext
      with a constant-time compare. On mismatch, roll back the transaction.
   5. Audit `credential.migrated` with metadata only.
3. **Shadow read.** With `connect_google_v2_read` on for one internal org,
   free/busy reads v2 and compares the result shape with v1 (the token is not
   compared or logged).
4. **Cutover per org.** Flip the flag. From then on, refresh writes go to v2
   only.
5. **Retention.** v1 rows remain for **30 days** after cutover, read by nothing.
   Deleting them needs a separate approval.

## 5. Rollback

- *Before cutover:* turn the flag off and delete v2 rows. v1 was never
  touched, so the state equals pre-migration.
- *After cutover:* turn the flag off and the code reads v1 again. Caveat: if
  Google rotated the refresh token during v2 operation, v1 holds a stale refresh
  token. Mitigation: the broker mirrors refreshed tokens to v1 (v1 AAD) during
  the 30-day window. If that mirror write fails, the v2 refresh still succeeds,
  and the gap is logged as `credential.v1_mirror_failed`. Last resort: the org
  re-consents (one click).

## 6. Verification that the credential stays usable

None of these checks print, log, or compare token values except in-process with
a constant-time compare.

1. **Decryptability.** The broker's `healthcheck --connection <id>` decrypts and
   reports `{ok, key_id, credential_version, expires_at}` only.
2. **Liveness.** A free/busy request for a fixed 1-hour window on the org's
   primary calendar returns HTTP 200. That is read-only and has no side effects.
3. **Refresh path.** Force a refresh in staging (set `expires_at` to the past
   on a staging row) and confirm 200, `credential_version` + 1, and exactly one
   refresh call under concurrent requests (lock test).
4. **Scope.** `tokeninfo` reports that `calendar.freebusy` is still granted.

## 7. Staging rehearsal (required before the production request)

The rehearsal runs on the isolated local Supabase stack with a **throwaway**
key ring:

1. Seed a v1 G3 row using a test token. A staging Google test account
   (owner-provisioned) is needed for live steps 6.2–6.4.
2. Run the backfill.
3. Run the §6 checks.
4. Run both rollback paths.
5. Record the evidence in `tugpt-connect-evidence/`.

Steps without Google (crypto round-trip, self-check, rollback-before-cutover,
lock test) run with stubbed HTTP and are part of the broker test suite.
