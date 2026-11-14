# Production read-only verification: 2026-11-14

**Authorization (owner, 2026-11-14):**
- read-only verification of the production host configuration
- a metadata-only inventory of the Google credential record

No secret may be retrieved, printed, decrypted, copied, refreshed, rotated, re-encrypted, modified or deleted. Stop if credential contents would be needed.

## 1. Access path: what was and wasn't used

| Path | Result |
|---|---|
| SSH from the dev VPS to `212.227.44.13` | **not available.** The dev VPS has no private keys, and the production host key is not in `known_hosts`; a strict-checking attempt was refused before authentication. No further attempt was made. |
| Production Supabase `rbiumegrwtavmljxbknp` | **not accessed.** Any connection needs a database password or service key, and reading those from production configuration would itself be accessing a secret. |
| Public endpoints (DNS, TLS, HTTP responses) | used, read-only. This is what any visitor can see. |

So the host-internal checks and the credential inventory are **blocked**, not skipped. Both need an operator with existing production access to run the read-only commands in §3 and §4, and return the output.

## 2. Public observations (verified 2026-11-14)

| Check | Observation | Assessment |
|---|---|---|
| `dashboard.tugpt.pro` A record | `212.227.44.13` (no AAAA) | matches the expected production host |
| `tugpt.pro` | `217.160.0.31`, `2001:8d8:100f:f000::200` | marketing site, separate host |
| `staging.dashboard.tugpt.pro` | no record | expected; nothing created |
| `tugpt.app` | does not resolve | correct; never used |
| CAA on `tugpt.pro` | none | optional hardening (staging-setup A1) |
| TLS certificate | CN and SAN `dashboard.tugpt.pro`, Let's Encrypt `YE1`, valid 2026-11-12 → 2027-02-10 | OK; auto-renewal still to be confirmed on the host |
| Security headers | HSTS `max-age=31536000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` | good. No `Content-Security-Policy` header seen on `/`; to be reviewed separately. |
| `/` | 307 → `/dashboard` | expected |
| `/api/health` | 401 | the proxy comment says health is polled without credentials, so an upstream layer may be gating it. To be confirmed on the host. Informational. |
| `/api/v1/connect/oauth/callback/google` | 401 | route not deployed; the protected-route default answers. Expected. |
| `/api/v1/integrations/google/callback` (no parameters) | **307 → `https://0.0.0.0:3000/settings/integrations?google=error&reason=invalid_callback`** | **DEFECT.** See §2.1. |

### 2.1 Defect: Google callback redirects to the container's internal address

- **Cause:** `settingsIntegrationsUrl()` built the post-OAuth redirect from `request.url`. Behind the reverse proxy, the standalone Next.js server sees its bind address (`ENV HOSTNAME=0.0.0.0` in `apps/web/Dockerfile`).
- **Impact:** every user who finishes or cancels Google Calendar consent in production lands on an unreachable URL, so the flow looks broken even when the connection was stored.
- **Possibly related:** if `GOOGLE_OAUTH_REDIRECT_URI` isn't set in production, the consent request itself would send `redirect_uri=https://0.0.0.0:3000/...` and Google would refuse it (`redirect_uri_mismatch`). Whether it is set can't be determined without reading production configuration. It is a non-secret value, but it lives in an environment file alongside secrets, so the operator check in §3 covers it.
- **Fix (in this PR, not deployed):** the redirect now uses the origin of the pinned `GOOGLE_OAUTH_REDIRECT_URI`. That is operator configuration, never request input, so there is no open redirect. Without a pin, behaviour is unchanged. It has 6 tests, and a planted revert fails 3 of them.
- **Production action needed (owner approval):** deploy the fix, and make sure `GOOGLE_OAUTH_REDIRECT_URI=https://dashboard.tugpt.pro/api/v1/integrations/google/callback` is set. **Not done:** no production change was made.

## 3. Operator check: production host (read-only; run by someone with existing access)

Each command prints configuration **names**, versions and states, never secret values.

```bash
hostname; uptime; cat /etc/os-release | head -2
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} readonly={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}}' $(docker ps -q)
# env var NAMES only, never values:
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <web-container> | cut -d= -f1 | sort
# is the redirect URI pinned? prints only SET/UNSET:
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <web-container> | grep -q '^GOOGLE_OAUTH_REDIRECT_URI=https://dashboard.tugpt.pro/' && echo SET-CORRECT || echo UNSET-OR-DIFFERENT
ss -tlnp | awk '{print $4, $6}'                         # listening sockets
nginx -T 2>/dev/null | grep -E 'server_name|listen|proxy_pass|proxy_set_header (Host|X-Forwarded)' | sort -u
certbot certificates 2>/dev/null | grep -E 'Certificate Name|Expiry'; systemctl list-timers | grep -i certbot
ufw status verbose 2>/dev/null || nft list ruleset | grep -E 'dport|policy' | head -40
```

## 4. Operator check: Google credential inventory (metadata only)

Run as a read-only role in the production SQL editor. It selects **no** secret column. `key_id` is a key *identifier*, not key material. Before running, the operator confirms with `\d public.platform_secrets` and `\d public.organization_secrets` that the listed columns exist and that none of them holds secret material. If anything differs, **stop** rather than broaden the select.

```sql
-- Identical to docs/connect/google-credential-migration.md §1.1 (reviewed there).
-- Selected: identifiers, key id, timestamps, scopes, expiry. NOT selected: any ciphertext/iv/tag column.
select 'platform' as scope, null::uuid as organization_id, provider, secret_name,
       key_id, created_at, updated_at, null::text[] as scopes, null::timestamptz as expires_at
  from public.platform_secrets where provider = 'google'
union all
select 'organization', organization_id, provider, secret_name,
       key_id, created_at, updated_at, scopes, expires_at
  from public.organization_secrets where provider = 'google'
order by scope, organization_id nulls first;
```

The output tells us how many organizations the v1 → v2 migration (`google-credential-migration.md`) must carry, and whether the platform client exists. **Nothing here changes the production Google credential.**

## 5. Result

| Item | Status |
|---|---|
| Public configuration check | **done** (§2). One production defect found and fixed on the branch, not deployed. |
| Host-internal configuration | **blocked:** no non-secret access path. Operator command set provided (§3). |
| Google credential metadata inventory | **blocked:** database access would require reading a production secret. Metadata-only query provided (§4). |
| Any secret accessed | **none** |
