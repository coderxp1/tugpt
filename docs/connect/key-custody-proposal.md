# Proposal: custody of the Connect encryption keys

Status: **proposal, awaiting owner decision.** No production key material has been created, copied, backed up or transferred. This covers the broker's AES-256-GCM key ring (`tugpt_keyring`), the broker caller HMAC keys, and the legacy v1 credential key during migration.

## 1. Roles

| Role | Holder (proposed) | May | May not |
|---|---|---|---|
| **Key custodian (primary)** | the owner (Hartmann / jp@coderxp.pro) | hold the offline backup; authorize generation, rotation, recovery | use keys day to day |
| **Key custodian (secondary)** | one named second person chosen by the owner, or a sealed escrow (notary or bank deposit box) if there is no second person yet | hold the second backup share; co-authorize recovery | act alone |
| **Operator** | engineering (on-host) | start, stop and restart the broker; run the documented rotation script on the host | read key bytes; export keys; hold backups |
| **Broker process** | the `credential-broker` container | read `/run/secrets/tugpt_keyring` at start | anything else |

No AI agent, CI system, chat, ticket or repository ever holds key bytes. The admin MCP bridge has no access path to the key ring.

## 2. Generation

- Keys are generated **on the production broker host** by the operator, in the owner's presence (screen share is acceptable), using `openssl rand -base64 32`. The output goes straight into `systemd-creds encrypt` (bound to the host's TPM2 if present, otherwise the host key). It is never printed.
- Key ids are dated, e.g. `k2026q4`. The ring file holds `key_id=base64` lines. Only the newest key encrypts; older keys only decrypt.

## 3. Offline backup

- **Method:** each key is split 2-of-3 with Shamir's Secret Sharing (`ssss`, offline, open source, free) at generation time:
  - share 1: owner, printed on paper, in a home safe
  - share 2: secondary custodian or sealed escrow
  - share 3: an encrypted file (`age` with the owner's offline passphrase) on a USB stick kept apart from share 1

  Any two shares recover the key, and one lost share is survivable.
- **What is not a backup:** database backups. They contain ciphertext only, and that is intentional. Key backups and database backups are never stored together.
- Backups are created **only** at generation and rotation, and **only** after the owner approves the procedure. **None exist today.**

## 4. Access controls

- **Host:** the key ring is a `systemd-creds` credential, decrypted into the broker's tmpfs `/run/secrets` (mode 0400, owned by the broker uid), and is never on persistent disk in clear text.
- **SSH to the broker host:** key-only and limited to named operators. Every session is logged. The broker host does not run the admin MCP bridge.
- **Broker container:** read-only rootfs, `cap-drop ALL`, no shell utilities needed at runtime, no published port, reachable only on internal networks.
- **Database:** ciphertext is readable only by the `connect_broker` role; see `broker-durable-storage.md`.

## 5. Recovery

**Trigger:** the broker host is lost or rebuilt, or the credential store is corrupted.

1. The owner approves recovery in writing (an email or ticket with a timestamp).
2. Two custodians combine shares on an **offline** machine. The recovered key goes directly into `systemd-creds encrypt` on the new host, typed or pasted locally. It is never sent over chat or email.
3. The broker starts. The startup check confirms every `key_id` in the database is present in the ring, and a canary decrypt succeeds.
4. The recovery is recorded (§7). Rotation is scheduled within 30 days if exposure can't be ruled out.
5. **If the keys are unrecoverable:** stored connections can't be decrypted. They are marked `requires_authorization`, and users reconnect. This is availability loss, not a data breach, and is the designed fail-safe.

**Recovery drill:** once before go-live and then yearly, against a **staging** ring, never production.

## 6. Rotation

- **Scheduled:** every 12 months. **Unscheduled:** immediately on suspected exposure, or when a custodian or operator with access leaves.
- **Procedure:**
  1. Add a new key to the ring.
  2. Mark it active, so new writes and refreshes use it.
  3. A background re-encryption job re-wraps old rows: decrypt with the old key, encrypt with the new one, bump the version, CAS, and log `credential_access_log` detail `REWRAP`.
  4. When `SELECT count(*) … WHERE key_id = old` = 0, remove the old key from the ring after a 7-day hold.
  5. Destroy the old key's backup shares, and record the destruction.
- HMAC caller keys rotate the same way: the broker accepts both keys during a 24 h overlap.

## 7. Auditability

- **Key custody log:** an append-only document in the owner's records (not the repo). Each entry records date, action (generate, backup, recover, rotate, destroy), key id, participants, approval reference and outcome. It holds no key material.
- **Broker:** startup records each loaded key id and the canary result (ids only). Every token operation is written to `credential_access_log`. Re-wrap progress is visible by `key_id` counts.
- **Host:** `systemd-creds` and SSH session logs are shipped to the existing log store.
- **Quarterly review by the owner:** the custody log, the operator list, and key ages.

## 8. Decisions requested from the owner

1. Confirm yourself as primary custodian, and name the secondary custodian or escrow.
2. Approve 2-of-3 Shamir with paper, escrow and encrypted USB, or choose a simpler single offline copy (higher loss risk).
3. Approve the 12-month rotation cadence and the yearly recovery drill.
4. Approve that production keys are generated only during a scheduled session with you present.
