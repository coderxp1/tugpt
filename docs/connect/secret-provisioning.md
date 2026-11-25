# Credential broker: secret store convention and provisioning procedure

Status: **procedure only, nothing provisioned.** No key ring, caller key or broker database login exists on any non-harness system. The steps below need owner approval and the owner's presence; agents never generate or see production values.

## 1. What exists on the VPS today (observed read-only, 2026-11-21)

| Item | Observed |
|---|---|
| `/run/secrets` | does not exist |
| Secret files | `/etc/tugpt-<service>/service-secrets/*.env` (e.g. `/etc/tugpt-dashboard-e2e/service-secrets/{auth,rest,web}.env`, `qa-accounts.json`): directory `root:root 0700`, files `root:root 0600` |
| How web receives them | Docker env file at container creation. The keys in `web.env` (`TUGPT_APP_ORIGIN`, `TUGPT_SUPABASE_URL`, `TUGPT_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) exactly match the container's `Config.Env` |
| Consequence | values sit in the container config: anyone with Docker access can read them with `docker inspect` |
| Restart persistence | staging containers use restart policy `no`; env is fixed at creation, so rotating means recreating the container |
| systemd | v259 with `systemd-creds` available; `/etc/credstore` and `/etc/credstore.encrypted` exist and are empty; no TuGPT unit uses `LoadCredential`/`EnvironmentFile` |
| Broker variables | none: `TUGPT_BROKER_URL` and `TUGPT_BROKER_CALLER_KEY` are absent from every observed env file and container |
| Broker process | none: `packages/credential-broker/src/server.ts` exports `createBrokerServer` but there is no entry point that loads a key ring or builds a pg pool yet |

## 2. Secrets the broker needs

| Secret | Consumer | Format (from code) |
|---|---|---|
| Key ring | broker only | lines `key_id=<base64 of 32 random bytes>` (`crypto-v2.ts`), plus the write key id |
| Caller key `web` | broker (verify) + web (sign) | at least 32 bytes, hex in `TUGPT_BROKER_CALLER_KEY` (`apps/web/src/lib/chat/connect.ts`) |
| Caller key `worker` | broker (verify) + worker (sign) | same format |
| Caller key `executor` | broker (verify) + web server-side chat execution (sign) | same format, in `TUGPT_BROKER_EXECUTOR_KEY` (`apps/web/src/lib/chat/connect.ts`, `executorClient`); read-only operations `get_access_token`, `get_static_secret` (`packages/credential-broker/src/authz.ts`); must differ from the web key |
| DB login for `connect_broker` | broker only | a LOGIN role that is a member of the NOLOGIN `connect_broker` (migration 20261120000012), password or client cert |

## 3. Procedure (owner-run, after approval of `docs/connect/key-custody-proposal.md`)

1. **DB login.** On the target database, as the owner: `CREATE ROLE tugpt_broker_login LOGIN PASSWORD '<entered interactively>' IN ROLE connect_broker;`. Use `\password` in psql so the value never reaches shell history. No other grants.
2. **Key ring.** On the host: `umask 077; printf 'org.v1=%s\n' "$(openssl rand -base64 32)" | systemd-creds encrypt --name=tugpt_keyring - /etc/credstore.encrypted/tugpt_keyring`. Never print it. Create offline backup shares per the custody proposal.
3. **Caller keys.** For web and worker separately: `openssl rand -hex 32 | systemd-creds encrypt --name=tugpt_caller_web - /etc/credstore.encrypted/tugpt_caller_web` (and `tugpt_caller_worker`, `tugpt_caller_executor`). Generate each key separately; never reuse one value for two callers.
4. **Broker unit** (to be written once the entry point exists): `LoadCredentialEncrypted=tugpt_keyring`, `LoadCredentialEncrypted=tugpt_caller_web`, `LoadCredentialEncrypted=tugpt_caller_worker` and `LoadCredentialEncrypted=tugpt_broker_db`. systemd decrypts them to `$CREDENTIALS_DIRECTORY` (tmpfs, mode 0400, owned by the unit's user). Run with `DynamicUser=yes`, `ProtectSystem=strict` and no published port.
5. **Web and worker** get only their own caller key and `TUGPT_BROKER_URL`. Preferred: the same `LoadCredentialEncrypted` mechanism, read from a file at start. If they stay Docker containers, mount the decrypted file read-only instead of passing it as env, so it doesn't appear in `docker inspect`. This needs an app change, because web currently reads the key from env.
6. **Verify** without printing values: the broker's `/healthz` answers, web's `connection_status` call returns 200 or 404, and a key-ring fingerprint (`sha256` of the key id list only) is recorded in the custody log.

## 4. Rotation and restarts

- **Key ring:** add `org.v2=...` as a new line, re-encrypt the credential, restart the broker and set the write key id to `org.v2`. Old ciphertext still decrypts with `org.v1` (the key id is stored per row) and is re-encrypted on the next write. Remove `org.v1` only after every row has `key_id = 'org.v2'`. This is the 12-month dual-key overlap.
- **Caller keys:** the broker accepts several keys per caller (`callerKeys: Map<Caller, Buffer[]>`). Add the new key, restart the broker, switch the caller and restart it, then remove the old key within 24 h.
- **Restart persistence:** encrypted credentials in `/etc/credstore.encrypted` survive reboots and are only decrypted for the unit. Plain env files do not give that protection.

## 5. Open decisions (owner)
- Approve the key-custody proposal (custodians, backup shares, rotation interval).
- Where the broker runs (systemd service vs container) and on which internal network.
- Whether web and worker move from env to credential files (recommended, see 3.5).
