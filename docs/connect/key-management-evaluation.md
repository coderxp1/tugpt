# Key management: evaluation and decision (Phase 0)

Owner requirements (2026-11-12):

- A dedicated internal credential/key service, outside the public web app.
- Restricted service-to-service authentication and no public access.
- Org-scoped operations and auditable access.
- Key rotation and recovery.
- Application credentials kept separate from encryption keys.
- **First evaluate existing infrastructure.** No paid services and no
  production secret changes. Staging first.

## Current state (from the code, 2026-11-12)

| Item | Where | Observation |
|---|---|---|
| Ciphertext | `public.organization_secrets`, `public.platform_secrets` (`20260903000003_secret_storage.sql`) | AES-256-GCM, 96-bit random IV, `UNIQUE(key_id, iv)`, `key_id` column; only `service_role` has table privileges; RLS on. |
| AAD (v1) | `packages/security/src/secret-crypto.ts` | `org_id ␟ provider ␟ secret_name`. Binds ciphertext to a row *identity*, not to a row: two connections of the same provider in one org would share an AAD. |
| Key ring | env vars `TUGPT_SECRET_KEY_<ID>` (base64, 32 bytes); write key `TUGPT_SECRET_WRITE_KEY_ID` | Documented location `/etc/tugpt/worker.env` (0600 root). |
| Who holds keys | worker (transcription, appointments) **and the web app** (Google OAuth callback in `packages/appointments/src/google-oauth.ts`, called by `apps/web/.../integrations/google/*`) | The web app is internet-facing and holds the key ring. This contradicts `docs/credential-handover.md` §"What about web.env?". |
| Refresh write-back | `apps/worker/src/appointments-deps-factory.ts` | `persistCredential(...).catch(() => undefined)`, no lock. A rotated refresh token can be silently lost; concurrent refreshes race. |
| Key backup / recovery | not documented | Losing the key ring means every stored credential is unrecoverable. |

## Options

| Option | Cost | Keeps key out of DB | Keeps key out of web | Rotation | Ops burden | Verdict |
|---|---|---|---|---|---|---|
| A. Status quo: env key ring in web + worker | 0 | yes | **no** | manual, documented | low | **Reject.** Fails "not in the public web app". |
| B. Supabase Vault (pgsodium/`vault.decrypted_secrets`) | 0 | **no.** Any `service_role` or SQL-injection path that reaches the view decrypts. | yes | Supabase-managed root key; no per-tenant control | low | **Reject.** Contradicts ADR-020 D8 ("key the database does not hold"). pgsodium is also deprecated upstream. |
| C. OpenBao / HashiCorp Vault (transit engine), self-hosted | 0 licence (OpenBao MPL-2.0) | yes | yes | strong (transit key versions) | **high**: unseal ceremony, HA, backups, upgrades on a single VPS | **Defer.** The broker interface is designed so a transit backend can replace the local key ring later. |
| D. Cloud KMS (AWS/GCP/Azure) | **paid**, new vendor | yes | yes | strong | medium | **Excluded** (no paid services). |
| E. **Internal broker service + systemd-creds + Docker secret** | 0 (runs in the existing Docker stack) | yes | **yes** | key-ring versions + re-encrypt job | low–medium | **Chosen.** |

### What exists on the hosts (checked on the dev VPS; production to be confirmed read-only by the owner)

- systemd 259 with `systemd-creds` is available. There is no TPM2 (`/dev/tpm*`
  absent; `systemd-analyze has-tpm2` reports `partial`). Credentials therefore
  encrypt with the host key `/var/lib/systemd/credential.secret`. That protects
  a copied disk image or backup, not a live root compromise, which is acceptable
  and stated as such.
- Docker 29.9.2 (Swarm inactive). Compose file secrets mount a file into only
  the named service at `/run/secrets/<name>` (tmpfs-backed).
- Production host facts (systemd version, TPM, Docker version) are **not
  verified**. This evaluation did not touch production.

## Decision: `credential-broker` service

```
 web (public) ──┐  HMAC-signed, internal network only
 worker ────────┼──────────────► credential-broker ──► Postgres (ciphertext,
                │                 (no published port)    credential_access_log)
                │                 key ring: /run/secrets/tugpt_keyring
                ▼
         (never sees key ring)
```

1. **No public access.** The broker joins only a Docker network with
   `internal: true`, has no `ports:` mapping, and binds `0.0.0.0` inside that
   network only. Staging test: from the host's public interface the port is
   closed, and from a container outside the network the name does not resolve.
2. **Service-to-service authentication.** Each caller (`web`, `worker`) has its
   own 32-byte caller key, delivered as its own Docker secret. Every request
   carries `x-tugpt-caller`, `x-tugpt-timestamp`, and `x-tugpt-nonce`, plus
   `x-tugpt-signature = HMAC-SHA256(caller_key, method ␟ path ␟ timestamp ␟
   nonce ␟ sha256(body))`. Requests must be within ±60 s, and nonces are
   single-use (replay cache). A comparison is constant-time.
3. **Per-caller capability matrix.** Deny by default:
   - `web`: `store_oauth_result`, `connection_status`, `revoke`.
   - `worker`: `get_access_token`, `revoke`.
   - No caller has `export_refresh_token` or `decrypt_raw`. These operations
     do not exist.
4. **Org-scoped operations.** Every call names `(organization_id,
   connection_id)`. The broker loads the row with *both* predicates, and the
   ciphertext's AAD v2 includes both. A mismatched pair is `NOT_FOUND`,
   indistinguishable from a missing row.
5. **Separation of keys.**
   - *Encryption keys* (key ring) exist only in the broker.
   - *Caller keys* authenticate callers and cannot decrypt anything.
   - *Application credentials* (vendor OAuth client secrets) are vault rows
     encrypted under the ring, like any other secret.
   - The database holds ciphertext only.
6. **Audit.** `credential_access_log` is append-only: caller, operation, org,
   connection, outcome, request id, and timestamp. It holds no token material.
   Failed authentication is logged too (with org and connection null).
7. **Rotation.**
   - *Data-key rotation:* add `TUGPT_KEY_<NEW>` to the ring, switch the write
     key id, run the re-encrypt job by `key_id`, then verify zero rows remain on
     the old id. Only then remove the old key.
   - *Caller-key rotation:* the broker accepts two keys per caller during the
     overlap.
8. **Recovery.**
   - The key ring is backed up **offline by the owner**: an age-encrypted file
     in the owner's password manager, plus a second sealed copy.
   - Losing the ring means stored OAuth credentials are unrecoverable. Users
     must re-consent. The UI degrades to `requires_authorization`, and no other
     data is affected.
   - Restore drill in staging: wipe broker → restore ring from backup → read
     succeeds.
9. **Locked refresh with mandatory persistence.**
   - `pg_advisory_xact_lock(hashtext(connection_id))` plus a compare-and-swap
     on `credential_version`.
   - If the write fails, the call fails, and the new token is never used
     unless it was persisted.
   - A concurrent refresher re-reads instead of refreshing again.

## Staging plan

1. Package `@tugpt/credential-broker` (crypto v2, signing, authorization
   matrix, refresh coordinator, HTTP server). Unit tests run in CI.
2. Run it on the dev VPS in an isolated Docker network with a **generated
   throwaway** key ring and caller keys, against the isolated local Supabase
   stack. Prove: unsigned → 401; wrong caller → 403; cross-org → 404;
   replay → 401; not reachable from outside the network.
3. Only after owner approval: production rollout plan, which includes moving
   the web app off the key ring.
