# TuGPT Production Environment & Security Hardening Guide

This document describes the environment variable configurations, secret handling, and security boundaries required for deploying the TuGPT platform to production.

---

## 1. Production Environment Variables Checklist

Every production environment deployment requires the following variables to be explicitly defined. Do NOT fall back to local development defaults.

| Environment Variable | Source / Value | Security Boundary |
| :---- | :---- | :---- |
| `NEXT_PUBLIC_SUPABASE_URL` | Production Supabase Project URL | Publicly accessible in browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production Supabase Anonymous Key | Publicly accessible in browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | Production Supabase Service Role Key | **SECRET**. Server-side only. Must NEVER leak to client-side bundles. |
| `LANGDOCK_API_CODE` | Production Langdock Integration API Key (sole draft provider, see ADR-006) | **SECRET**. Server-side only. |
| `LANGDOCK_ENDPOINT_URL` | Production Langdock Endpoint URL (optional — defaults to `https://api.langdock.com/openai/eu/v1`) | Server-side only. |
| `LANGDOCK_MODELS` | Ordered rotation list, cheapest first, e.g. `gpt-5-mini,gpt-5.1,gpt-5.2,gpt-5`. On a per-model quota rejection the next model is tried within the same attempt. Defaults to the whole allowlist when unset. **This is what the server runs.** See ADR-006. | Server-side only. Not a secret. |
| `LANGDOCK_MODEL` | Pins exactly one model and disables rotation. Kept for deployments predating rotation, and as the escape hatch. Ignored when `LANGDOCK_MODELS` is also set — the more specific variable wins, and the override is logged at boot. Allowed values: `gpt-5-mini`, `gpt-5.1`, `gpt-5.2`, `gpt-5`. Anything else is rejected at worker boot. | Server-side only. Not a secret. |
| `GATEWAY_API_MASTRA_KEY` | Production Mastra Orchestrator API Key | **SECRET**. Server-side only. |
| `GATEWAY_API_URL` | Production Mastra Endpoint URL | Server-side only. |
| `TUGPT_DOMAIN` | Public hostname the dashboard is served on. `dashboard.tugpt.pro` since 2026-11-01 (§5.4d). Read by the Caddy reverse proxy only (section 5.4b), and only when the `proxy` compose profile is enabled. | Not a secret. |
| `IONOS_API_KEY` | IONOS voice API key. **Present but empty on the server as of 2026-08-25** — the account is not configured yet. Nothing reads it at boot, so an empty value is safe; a wrong one would not be caught until something first calls it. | **SECRET**. Server-side only. |
| `LANGDOCK_IMAGE_*` | Credentials for the Langdock image-generation agent. **No production code reads these names yet.** They are on the server so the values are not lost; whoever wires that agent must read exactly these names rather than inventing new ones. | **SECRET**. Server-side only. |
| `LANGDOCK_DOCZIP_*` | Credentials for the Langdock doczip agent. Same status and same rule as `LANGDOCK_IMAGE_*`. | **SECRET**. Server-side only. |

**Removed as of 2026-08-18 (see ADR-006):** `LOGICC_API_KEY`, `LOGICC_ENDPOINT_URL`, `LOGICC_DEFAULT_MODEL`, `ANYMIZE_API_KEY`, `ANYMIZE_ENDPOINT_URL`, `ANYMIZE_DEFAULT_MODEL`, and `MODEL` are no longer read anywhere in the codebase. Logicc was cut for cost; Anymize was removed to avoid cross-project coupling (it remains in use on other projects).

**Do not add `LOGICC_*` to an env file.** Bringing Logicc back is a revision of ADR-006 — cost analysis, model selection, adapter wiring — not an environment edit. The 2026-08-25 rebuild deliberately did not add them even though its model catalogue came up again the same day. An env var with no adapter behind it is worse than nothing: it reads as configured and does nothing.

**Correction (2026-08-19):** this section previously said model selection was Langdock's `auto` routing and that no model env var was needed. That was wrong — Langdock's OpenAI-compatible endpoint has no `auto` model and returns HTTP 400 for it. Model selection is now `LANGDOCK_MODELS` (rotation) or `LANGDOCK_MODEL` (pinned), validated against a four-model allowlist. The generic `MODEL` variable really is dead: its last reader was deleted with `AIProviderFactory` in PR #17.

---

## 2. Server-Side vs. Client-Side Secret Isolation

To prevent exposing database secrets or service keys:

1. **Prefix Rule**: Only variables prefixed with `NEXT_PUBLIC_` are bundled into browser-side client bundles by Next.js.
2. **Admin Client Restrictions**: The `SUPABASE_SERVICE_ROLE_KEY` is a secret credential bypassing all PostgreSQL RLS policies. It must **never** be defined under client-side execution.
3. **Execution Guard**: `createAdminSupabaseClient` in `@tugpt/database` explicitly asserts `typeof window === 'undefined'` to block instantiation if imported or run inside client bundles.

---

## 3. Production PostgreSQL & Supabase Setup

When deploying database migrations in production:

1. **Migration-Driven**: All structural updates and grants must be driven via migrations (`supabase db push`). No manual SQL client modifications.
2. **Schema Hardening**:
   - Schema `private` holds RLS resolver functions and is inaccessible to the `anon` role.
   - All `public` tables enforce Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`).
3. **Audit Log Immutability**: The `trigger_prevent_audit_log_modification` trigger blocks any user-level attempts to modify or delete logs under `public.audit_logs`.

---

## 4. Worker Runtime

The background workers (draft worker, WhatsApp worker) run via `tsx` in development, which handles ESM syntax in CJS mode. The worker app (`apps/worker/package.json`) must NOT have `"type": "module"` set, as the 8 internal packages are CommonJS and Node's ESM loader cannot do named imports from CJS modules. This was resolved in PR #10 (Aug 13, 2026).

**In production the workers also run under `tsx`, not `node dist/*.js`** — corrected 2026-08-25, when the first ever boot of the worker containers crash-looped:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/packages/database/src/client'
imported from /app/packages/database/src/index.ts
```

Every `@tugpt/*` package sets `"main": "./src/index.ts"` and none has a build script, so no `dist/` is ever produced for them. The worker's own `tsc` compiles only `apps/worker/src`, and that CommonJS output still `require()`s `@tugpt/database` as raw TypeScript. Node 22 type-strips the `.ts`, and from there the package's own extensionless `./client` import is resolved with ESM rules, which do not infer extensions — so the process dies before `main()`.

It hid for months because every earlier execution path — dev, the e2e harness, the old systemd-native units — ran under `tsx`, which resolves extensionless imports. The container start path was the one path nothing exercised.

`docker-compose.yml` therefore starts both workers with `pnpm exec tsx src/…`, and `apps/worker/tests/worker-start-command.test.ts` fails anyone who reverts that before the `@tugpt/*` packages gain real builds. Note also that `tsx` is a **devDependency**: the worker image installs dev dependencies, and adding `--prod` to that install would break production.

---

## 5. VPS Deployment (Docker Compose + systemd)

See ADR-013 for the decision record. This section is the operational runbook.

TuGPT runs on its own dedicated VPS at **`212.227.44.13`** — not a shared host, not Vercel. Vercel is no longer used at all; the deployment model is push to GitHub, deploy to this server.

**Current state, as of the 2026-08-25 rebuild.** The host was reinstalled after the 2026-08-24 compromise. `tugpt.service` is enabled and active and owns the entire compose stack — `web`, `whatsapp-worker`, `draft-worker`, and `caddy` under the `proxy` profile. There are **no** systemd-native workers on this box; they did not survive the wipe.

**This changed which section you follow.** 5.3 below is the fresh-host setup that was actually used, and it is the one to follow. 5.4 and 5.4a describe a cutover from systemd-native workers to containers — that migration is **historical and cannot be performed on this host**, because there is nothing to cut over from. They are kept because they explain artifacts you will still find (`tugpt-web.service`, the `Conflicts=` between the two units) and because the reasoning about queue consumers is still binding.

> **This document misled the 2026-08-25 deploy.** 5.3 said "`/etc/tugpt/worker.env` already exists — reuse it" and directed the operator to install `tugpt-web.service` rather than `tugpt.service`. Neither was true of a freshly installed box. If a section here contradicts the machine, believe the machine and fix the section in the same sitting.

### 5.1 Server layout

Actual, as of the 2026-08-25 rebuild:

```
/opt/tugpt/                        # this repo, checked out at the deployed commit
  docker-compose.yml
  apps/web/Dockerfile
  apps/worker/Dockerfile
  deploy/caddy/Caddyfile           # used by the `proxy` profile
  deploy/caddy/check-cert.sh       # TLS renewal check (5.4b)
  deploy/check-host.sh             # host security check (5.2)
/etc/tugpt/                        # dir 0700
  web.env                          # NEXT_PUBLIC_* + server secrets, root:root 0600
  worker.env                       # infra + provider secrets for both workers, root:root 0600
/etc/systemd/system/
  tugpt.service                    # enabled + active — supervises the whole compose stack
```

Both env files were **created new** during the rebuild. Nothing under `/etc/tugpt/`
survived the reinstall, and neither did any systemd-native worker unit — there is
no `tugpt-whatsapp-worker.service` or `tugpt-draft-worker.service` on this host.

`tugpt-web.service` still exists in the repo under `deploy/systemd/`. It runs only
the compose `web` service and belongs to the earlier web-only deployment. It is
**not** installed on this host, and the two units declare `Conflicts=` on each
other so they can never both be active. Leave it that way.

`web.env` needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
in addition to the server secrets, because Next.js inlines `NEXT_PUBLIC_*` at
**build** time rather than at container start. `tugpt.service` carries
`EnvironmentFile=/etc/tugpt/web.env` so a `systemctl restart` supplies them to
the build automatically; a hand-run `docker compose build` does not, and
`docker-compose.yml` declares those args with `${VAR:?...}` so it refuses rather
than baking empty strings into the image. Source the file first — see 5.4a.

### 5.2 Pre-deploy security check

**Run `deploy/check-host.sh`. Do not tick boxes by hand.**

```bash
cd /opt/tugpt
sudo sh deploy/check-host.sh
```

Exit 0 means nothing failed. Exit 1 means at least one check failed, and the run
printed what it found and what to do about it. Nothing in the script changes
anything on the host.

This section used to be the checkbox list now preserved at the bottom, and
nothing else. Its first item was "SSH key-based auth is enabled and password
auth is disabled." On 2026-08-24 the server was compromised with root password
SSH still enabled and had to be reinstalled from scratch. The box was never
confirmed against that list, and nothing anywhere recorded that it hadn't been.
A checklist only works if somebody reads it and answers it honestly; a script
that exits non-zero works whether or not anybody does either.

Run it:

- on a fresh box **before** anything is deployed — it is built for a half-built
  machine and reports what does not exist yet as `skip`, never as a pass;
- again after 5.3 and 5.4b, when the containers and the proxy exist and the
  checks that were skipped can actually run;
- periodically after that. The run prints `skip is not a pass` for a reason.

Every check runs even when an earlier one fails, so one run gives the whole
picture rather than one problem at a time.

| check | fails when |
| --- | --- |
| `ssh.password` | `PasswordAuthentication yes`. The 2026-08-24 entry point. |
| `ssh.root` | `PermitRootLogin yes` — root reachable over the network. |
| `ssh.kbdinteractive` | `KbdInteractiveAuthentication yes`. With PAM this is a second door to the same password even when `PasswordAuthentication` is `no`, which is why disabling one setting is not enough. |
| `firewall` | `ufw` is installed but inactive. Warns on any port open beyond 22/80/443. |
| `listeners` | anything is bound to a wildcard address outside 22/80/443. |
| `docker.ports` | a container publishes to `0.0.0.0`/`[::]` outside 80/443. Docker writes its own iptables rules and can publish a port past `ufw`. |
| `webservers` | `nginx`, `apache2`, `httpd`, `lighttpd` or `caddy` is active on the host, competing with the Caddy container for 80/443. |
| `units` | `tugpt.service` is enabled alongside `tugpt-web.service` or any native worker unit — two consumers on one queue, or two web servers competing. Neither exists on this host; the check is what keeps it that way. |
| `env.web.env`, `env.worker.env` | `/etc/tugpt/*.env` is not `600 root:root`. |
| `dns.host` | warns when `/etc/resolv.conf` lists only loopback resolvers (the systemd-resolved stub). |
| `dns.pinned` | the `dns:` pin has been removed from the `caddy` service in `docker-compose.yml`. |
| `dns.acme` | the running Caddy container cannot resolve Let's Encrypt — the silent renewal failure described in 5.4b. |

Run it as root. `sshd -T` is the only authoritative source for the SSH settings:
it resolves `Include` directives and `/etc/ssh/sshd_config.d/` drop-ins, and a
cloud image re-enabling password auth in a drop-in underneath a correct-looking
`sshd_config` is the most likely shape of what happened here. Without root the
script falls back to reading the config text and says so, rather than reporting
a pass it cannot justify.

`deploy/check-host.test.sh` tests the checker against recorded fixtures — case 1
reproduces the machine that was lost, case 3 a half-built box, case 5 the
degraded non-root path. It runs in CI as the `deploy-scripts` job, alongside
`shellcheck`. An unchecked checker is the same failure one level up.

Ongoing, `deploy/caddy/check-cert.sh` covers certificate expiry and container
DNS on a schedule; see 5.4b.

<details>
<summary>The original prose checklist, superseded by the script above</summary>

Every item below is now one of the checks in the table. It is kept for the
record, and because it is the artifact the post-mortem is about.

- [ ] SSH key-based auth is enabled and password auth is disabled (`PasswordAuthentication no` in `sshd_config`).
- [ ] `ufw` (or equivalent) allows only 22 (SSH), 80, and 443 inbound; no other ports reachable from the public internet.
- [ ] No application port (`3001` for `web`, or any worker) is bound to `0.0.0.0` — loopback-only, confirmed with `ss -tlnp` after the stack is up. (80 and 443 are bound publicly by the `proxy` profile when it is enabled, 5.4b — that is the one intended exception.)
- [ ] Docker itself isn't punching holes through `ufw` (Docker's default iptables behavior can bypass ufw rules for published ports) — verify with `iptables -L DOCKER-USER` or by testing from outside the host that `3001` is unreachable externally.

</details>

**Ports and services this host has already been observed to conflict with.** All of these were hit on the 2026-08-24 deployment; none is hypothetical. They were found on the *pre-wipe* box and are listed as the failure modes to expect, not as the current state — the 2026-08-25 rebuild started from a clean install and `check-host.sh` ends 0 failed, 0 warned, 0 skipped on it. Expect them again on any host that is not freshly installed. `check-host.sh` covers all four — the commands are here so you can see what it is looking at, and to run by hand when diagnosing a failure it reports.

```bash
ss -tlnp | grep -E ':(80|443|3000|3001)\b'   # what already holds the ports
systemctl is-active nginx apache2            # a web server with no vhosts still binds 80/443
docker ps --format '{{.Names}}\t{{.Ports}}'  # an unrelated container on 3001
systemctl is-enabled tugpt-web               # an older native build on 3000
```

- **3001** was held by an unrelated `open-webui` container.
- **80/443** were held by an `nginx` with no configured vhosts. It has to be stopped *and disabled*, or it takes the ports back on the next boot and Caddy fails to bind.
- **3000** was held by a stale `tugpt-web.service` from an earlier native build. Once the compose container is the deployment, that unit must be stopped and disabled, or two web servers compete for the same role and which one answers depends on boot order.

### 5.3 First-time setup on a fresh host

This is the path the 2026-08-25 rebuild actually took. It assumes a freshly
installed machine: no `/etc/tugpt/`, no worker units, nothing carried over.

Run the 5.2 check twice: once as soon as the repo is on the box, before any of
this — it is designed for a machine where nothing exists yet and will tell you
what it cannot see rather than failing — and again at the end of 5.4b, when the
containers and the proxy exist and the checks it skipped can run for real.

```bash
# as root, or a user with docker access
git clone <repo> /opt/tugpt
cd /opt/tugpt

sudo sh deploy/check-host.sh   # 5.2. Fix anything it FAILs before continuing.

mkdir -p /etc/tugpt
chmod 700 /etc/tugpt

# BOTH env files are new on a fresh host. Neither survives a reinstall.
install -m 600 -o root -g root /dev/null /etc/tugpt/web.env      # then edit
install -m 600 -o root -g root /dev/null /etc/tugpt/worker.env   # then edit
```

`web.env` needs at minimum `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `TUGPT_DOMAIN`.
`worker.env` needs the infrastructure credentials plus `LANGDOCK_API_CODE` and
`LANGDOCK_MODELS`. See section 1 for the full table, including the variables that
are present-but-empty (`IONOS_API_KEY`) and the ones nothing reads yet
(`LANGDOCK_IMAGE_*`, `LANGDOCK_DOCZIP_*`).

Then install the stack unit — `tugpt.service`, **not** `tugpt-web.service`:

```bash
cp deploy/systemd/tugpt.service /etc/systemd/system/tugpt.service
systemctl daemon-reload
systemctl enable --now tugpt.service
```

`tugpt.service` brings up the whole compose file and is correct on a fresh host
precisely because there is nothing else consuming the queues. Do not install
`tugpt-web.service` as well; the two `Conflicts=` each other and it belongs to a
deployment shape this host does not have.

**Verify.**

```bash
systemctl status tugpt.service
docker compose -p tugpt ps                       # web, whatsapp-worker, draft-worker, caddy
ss -tlnp | grep 3001                             # loopback only — never 0.0.0.0
curl -fsS http://127.0.0.1:3001/api/v1/health

docker compose -p tugpt logs --tail=50 whatsapp-worker draft-worker
# "Worker started. Polling whatsapp_inbound queue..."  exactly once
# "Draft worker started"                               exactly once
```

Then continue to 5.4b for TLS and public reachability, and re-run
`sudo sh deploy/check-host.sh` afterwards — it must end 0 failed.

### 5.4 Historical: the cutover from systemd-native workers (does not apply to this host)

**This migration cannot be performed on the current server and is kept only as a
record.** It described moving `tugpt-whatsapp-worker` and `tugpt-draft-worker`
from systemd-native Node processes onto containers, in one sequence, so that two
consumers never polled the same PGMQ queue. The 2026-08-24 compromise ended it:
the host was reinstalled, no native units came back, and 5.3 above went straight
to the full stack. There was never a moment with two consumers on a queue.

What survives from it, and is still binding:

- **One consumer per queue.** `whatsapp_inbound` and `draft_generation` must each
  have exactly one poller. That is a property of the queues, not of the old
  units, and it outlives them. Before starting anything that polls — a stray
  `docker compose up` under another project name, a hand-run `pnpm dev` against
  production credentials — check what is already running.
- **`Conflicts=` between `tugpt.service` and `tugpt-web.service`.** Still declared,
  still correct, still the reason you cannot accidentally run both shapes at once.
- **The rollback instinct.** If verification looks wrong — either side polling
  when it should not, or neither side polling — stop rather than proceed.

Step 5 of the old sequence said to keep the native unit files on disk as a
rollback path. There are none on this host, so there is nothing to keep and
nothing to delete later.

### 5.4a Historical: web-only deployment (2026-08-20)

**Superseded.** This was the shape between 2026-08-20 and the rebuild: the web app
on Docker via `tugpt-web.service`, workers still systemd-native. The current host
runs the full stack under `tugpt.service` (5.3). `tugpt-web.service` remains in the
repo, is not installed here, and should stay uninstalled.

One instruction from this section is still needed and is *not* historical:

**Why the env file has to be sourced for a manual build.** Next.js inlines
`NEXT_PUBLIC_*` at build time, into the *server* bundle as well as the client one,
so those two values must be present as Docker build args. `docker-compose.yml`
declares them with `${VAR:?...}`, which fails the build loudly rather than baking
empty strings. `tugpt.service` supplies them via
`EnvironmentFile=/etc/tugpt/web.env`; building by hand does not, so source it
first:

```bash
set -a; . /etc/tugpt/web.env; set +a
docker compose -p tugpt up -d --build web
```

Getting this wrong used to be silent and total: an image built with empty
`NEXT_PUBLIC_SUPABASE_URL` sends every `/dashboard` request to `/auth/login` (see
the guard in `apps/web/src/proxy.ts`), `server.ts` throws "Supabase URL is
missing", and every `/api/v1` route builds a client against `''`. The app looks
deployed and is entirely dead, and it reads like an authentication bug rather
than a build one.

### 5.4b Making the dashboard reachable from a browser (optional, opt-in)

5.3 leaves the app listening on loopback only. A reviewer cannot open it. This adds TLS termination and public routing in front of it.

**On the current host this is already done** — Caddy is running under the `proxy` profile with a Let's Encrypt certificate for `dashboard.tugpt.pro` and renewal on. The section stays as the reference for how it was set up, what to check, and how it fails.

Caddy rather than nginx: certificates are obtained and renewed from Let's Encrypt automatically, with no certbot and no cron entry to forget. The whole configuration is `deploy/caddy/Caddyfile`, about twenty lines.

This section originally added "and no renewal that can quietly stop working." That was wrong, and the 2026-08-24 deployment showed how — renewal can fail silently for reasons outside Caddy, DNS being the one we hit. See the DNS note below and `deploy/caddy/check-cert.sh`.

**It is off by default in compose.** The service carries `profiles: ["proxy"]`, so `docker compose up -d web` neither starts it nor can start it by accident. `tugpt.service` passes `--profile proxy`, so the unit that owns the stack starts and stops it along with everything else.

> **Settled 2026-08-26.** `tugpt.service` used to run without `--profile proxy`, which left Caddy outside the unit that owns the stack while `--remove-orphans` ran. A `--dry-run` showed the plan touched only `web` and the two workers — Caddy was neither stopped nor removed — so there was never an outage waiting to happen, and `restart: unless-stopped` carried it across reboots as well.
>
> It was still the wrong shape: TLS depended on an orphan-exemption plus a container restart policy rather than on the unit that supervises the stack. Both `ExecStart` and `ExecStop` now pass `--profile proxy`.
>
> **Expect one change in behaviour.** `systemctl restart tugpt.service` now recycles Caddy along with everything else, where before it left the container alone. That is a brief interruption, not a re-issuance — the certificate and the ACME account key live in the `caddy_data` named volume, so Caddy reloads what it already has instead of going back to Let's Encrypt.

**Before enabling:**

- [ ] A DNS **`A` record only** for the intended hostname points at `212.227.44.13`. Caddy proves control of the name to Let's Encrypt; without working DNS it cannot get a certificate. **Do not add an `AAAA` record** — this host has no IPv6 egress, so an `AAAA` advertises a path Let's Encrypt would try and fail to validate. See §5.4c.
- [ ] `TUGPT_DOMAIN=<that hostname>` is in `/etc/tugpt/web.env`. If it is missing, Caddy starts and then fails to obtain a certificate for `TUGPT_DOMAIN-is-not-set.invalid` — the name is chosen so the log line names the problem.
- [ ] `ufw` allows 80 and 443 inbound (5.2 already assumes this). Both are needed: 80 for the ACME challenge and for the HTTP→HTTPS redirect.

```bash
cd /opt/tugpt
docker compose -p tugpt --profile proxy up -d caddy
```

**Verify:**

```bash
docker compose -p tugpt --profile proxy ps            # web + caddy
docker compose -p tugpt logs --tail=50 caddy          # watch the certificate get issued
curl -fsSI http://$TUGPT_DOMAIN/api/v1/health         # 308 redirect to https
curl -fsS  https://$TUGPT_DOMAIN/api/v1/health        # {"status":"ok",...}
```

**To stop it** without touching the app: `docker compose -p tugpt --profile proxy stop caddy`. The web container keeps serving on loopback.

#### The URL to give a reviewer

**`https://<TUGPT_DOMAIN>/`** — that is the whole answer, and it works whether or not they are signed in.

`/` redirects to `/dashboard/drafts`. That is a protected route, so the proxy sends a signed-out visitor to `/auth/login?redirect=/dashboard/drafts`, and the login page returns them to the inbox once they authenticate. A signed-in reviewer goes straight there.

The routes behind it, for debugging:

| Path | |
|---|---|
| `/` | redirect to the inbox — no page of its own |
| `/dashboard/drafts` | the reviewer inbox, the actual destination |
| `/dashboard/drafts/[draftId]` | one draft: revisions, review history, approve / edit / reject |
| `/auth/login` | email + password; honours `?redirect=` |
| `/api/v1/health` | liveness, unauthenticated by design |

Until 2026-08-24 `/` was the untouched `create-next-app` boilerplate — Next.js logo, "To get started, edit the page.tsx file", and a "Deploy Now" button linking to Vercel. Nothing linked to it and the app had never been served from a domain anyone would type by hand, so nobody had looked. It was the first thing a visitor to the site saw.

#### DNS inside the container, and why a renewal can fail silently

Docker copies the host's `/etc/resolv.conf` into containers. On a systemd-resolved host that file can contain only `127.0.0.53` — the stub listener, which lives in the host's network namespace and is unreachable from inside a container. Docker usually detects the stub and substitutes public resolvers. On 2026-08-24 it did not, and the first ACME challenge failed with no DNS at all.

That was fixed on the host by repointing `/etc/resolv.conf` at `/run/systemd/resolve/resolv.conf`, which works and is one symlink away from silently reverting. **The compose file now pins explicit resolvers on the `caddy` service**, so the container does not depend on the host file at all.

This matters more than it looks. Caddy renews at roughly two-thirds of the certificate lifetime — about 30 days out on a 90-day Let's Encrypt certificate. If DNS is broken, the existing certificate keeps serving perfectly while every renewal attempt fails, and the first symptom is the site going down at expiry, weeks later, with nothing in between.

`deploy/caddy/check-cert.sh` is the second line of defence. It resolves the ACME host from inside the container and checks how many days the served certificate has left, failing under three weeks — by which point renewal has already been failing for a week or more:

```bash
cd /opt/tugpt
set -a; . /etc/tugpt/web.env; set +a
sh deploy/caddy/check-cert.sh
# ok    dns   caddy resolves acme-v02.api.letsencrypt.org
# ok    cert  dashboard.tugpt.pro valid for 89d
```

Invoked as `sh <path>` rather than `./<path>` because the file arrives through the GitHub API, which writes blobs as `0644` — the executable bit does not survive a fresh clone.

Optional, as root, to be told rather than to remember:

```cron
0 7 * * 1 cd /opt/tugpt && set -a && . /etc/tugpt/web.env && set +a && \
  sh deploy/caddy/check-cert.sh || \
  logger -t tugpt-cert -p daemon.err "TLS check failed on dashboard.tugpt.pro"
```

Weekly gives roughly four warnings between the first failed renewal and an outage.

**A correction to what 5.4a used to say.** It claimed Supabase Auth would need the new origin in its redirect allowlist before anyone could log in. That is wrong for the flow this app actually uses: `apps/web/src/app/auth/login/page.tsx` calls `supabase.auth.signInWithPassword`, a direct API call from the browser that involves no redirect URL at all. **Email/password sign-in works as soon as the proxy is up, with no Supabase configuration change.**

Where `site_url` and the redirect allowlist *do* matter:

- The `/auth/callback` page, which handles an OAuth code exchange. Nothing routes to it today, but it exists and would need the origin allowlisted before any OAuth provider is switched on.
- Confirmation and password-recovery emails. `supabase/config.toml` sets `enable_confirmations = true`, so a newly created reviewer receives a confirmation link built from `site_url`. If that still points at the retired Vercel deployment, the link lands nowhere. Worth fixing when reviewer accounts are created — Supabase configuration, not a repo change.

**On the WhatsApp webhook.** Once this is up, `https://<TUGPT_DOMAIN>/api/v1/webhooks/whatsapp` is publicly reachable, which is what Meta will eventually require. It returns 404 today and keeps returning 404 until `whatsapp_integration` is flipped in `packages/feature-flags/src/flags.ts` — a reviewed code change, per ADR-010 amendment 2. Exposing the path does not enable the feature and does not move it closer to enabled.

### 5.4c Domain migration to tugpt.app (2026-08-28)
> **Superseded on 2026-11-01 (§5.4d).** `tugpt.app` is not part of the TuGPT setup. Kept only as a historical record; do not follow these steps.


**`tugpt.ai` is no longer ours and is to be treated as hostile.** Control of the
registration was lost. Nothing in this repository, on this host, or in any
dashboard we own may point at it again. `tugpt.app` is canonical.

**DNS:** `tugpt.app` → `212.227.44.13`, **A record only, no AAAA.** Do not add
one. The Caddy container pins its own resolvers (§5.4b) but the host itself has
no IPv6 egress, and an AAAA record would advertise a path Let's Encrypt would
then try and fail to validate.

**`.app` is on the HSTS preload list.** Browsers refuse plaintext to it
unconditionally, so there is no degraded-but-reachable state: until the
certificate issues, the site is simply gone. Watch the ACME log rather than
assuming.

**The switch itself is one environment variable.** The Caddyfile hardcodes no
domain — the site address is `{$TUGPT_DOMAIN}`, read from `/etc/tugpt/web.env`:

```bash
sudo sed -i 's/^TUGPT_DOMAIN=.*/TUGPT_DOMAIN=tugpt.app/' /etc/tugpt/web.env
grep -c '^TUGPT_DOMAIN=' /etc/tugpt/web.env    # exactly 1
sudo systemctl restart tugpt.service           # ExecStart carries --profile proxy
sudo docker logs -f "$(sudo docker ps -qf name=caddy)" 2>&1 | grep -iE 'certificate obtained|error'
```

Serving the old domain stops by construction: the Caddyfile has a single site
block and on-demand TLS is not enabled, so any other `Host` gets no certificate
and no response. There is nothing to remove.

**Acceptance:**

```bash
curl -fsSI http://tugpt.app/api/v1/health      # 308 -> https
curl -fsS  https://tugpt.app/api/v1/health     # {"status":"ok",...}
sudo TUGPT_DOMAIN=tugpt.app sh /opt/tugpt/deploy/caddy/check-cert.sh
sudo sh /opt/tugpt/deploy/check-host.sh        # 0/0/0
```

**What lives outside this repository, and must not be forgotten.** The domain
appears in three places no deploy can reach, and two of them are revocations
rather than updates:

| Where | Action | Why it is urgent |
|---|---|---|
| **Supabase → Auth → URL Configuration** | Site URL `https://tugpt.app`; add redirect `https://tugpt.app/auth/callback`; **delete every `tugpt.ai` entry** | The application hardcodes no origin — `signInWithGoogle` and `resetPassword` take `redirectTo` as a parameter and are not called, and the callback page uses relative paths. **The allowlist in that dashboard is the entire redirect security boundary.** While a `tugpt.ai` entry remains, whoever holds that domain can have Supabase hand them a valid auth code. |
| **Meta → WhatsApp webhook** | Remove the callback URL and unsubscribe the fields | Meta has been delivering to a domain we do not control, and its owner can answer the verification challenge however they like. Our endpoint returning 404 protects our server, not the traffic. |
| **`/etc/tugpt/web.env`** | `TUGPT_DOMAIN`, and rotate `WHATSAPP_VERIFY_TOKEN` | The old domain's owner has seen whatever Meta sent, including the verify token if it was ever exchanged. |

**Re-verifying the webhook on `tugpt.app` cannot succeed while
`whatsapp_integration` is off.** `apps/web/src/app/api/v1/webhooks/whatsapp/route.ts`
returns 404 from the GET handler before reading `hub.mode`, and Meta requires a
successful challenge to save a callback URL. Removing the subscription is
therefore the action available today; re-pointing it belongs to the supervised
flip, when the flag goes on and verification can actually complete.

**Before that flip: `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` must both
be non-empty in `/etc/tugpt/web.env`.** Since 2026-08-31 the route refuses every
request while either is blank — 403 on GET, 401 on POST, the same answers a
wrong token and a forged signature get, with a `[whatsapp-webhook]` line naming
the missing variable on the server. Verification will simply fail, indefinitely
and for a reason Meta's dashboard will not explain, so check the two lines
before re-pointing the callback rather than after.

That refusal replaced `process.env.X || ''`, which is worth stating plainly
because it was the actual behaviour until then: an unset verify token became the
empty string and matched `?hub.verify_token=` from any caller, and an unset app
secret keyed the HMAC on the empty string, which anyone can compute. The feature
flag was the only thing standing in front of both. A flag is a product switch,
not a security control, and it was one flip away from being the entire defence.

### 5.4d Domains on tugpt.pro (2026-11-01)

| Hostname | Purpose | Served by |
|---|---|---|
| `tugpt.pro` | Public website | IONOS web hosting. Not served or changed by this repository. |
| `dashboard.tugpt.pro` | User Dashboard (this web app) | VPS Caddy → Next.js. Same-origin `/auth/v1/*` and `/rest/v1/*` go to the Supabase API gateway. |
| `workspace.tugpt.pro` | AI Workspace | Reserved. Not routed until the Workspace is approved. |

**DNS:** `dashboard.tugpt.pro` must have A `82.165.50.109` and either AAAA `2a01:239:4c6:8100::1` or no AAAA. An AAAA record that still points at IONOS web hosting sends IPv6 visitors and certificate validation to the wrong server.

**Supabase → Auth → URL configuration:** Site URL `https://dashboard.tugpt.pro`; redirect allow-list `https://dashboard.tugpt.pro/auth/callback`. Delete every `tugpt.app` and `tugpt.ai` entry: the allow-list is the redirect security boundary, and a domain we do not control must never be on it.

**Build:** `NEXT_PUBLIC_SUPABASE_URL` is compiled into the browser bundle. Rebuild the web image after changing it, and set `TUGPT_APP_ORIGIN=https://dashboard.tugpt.pro`.

### 5.5 Building and deploying a new release

Two lines. `tugpt.service` carries `EnvironmentFile=/etc/tugpt/web.env`, so the
restart supplies the `NEXT_PUBLIC_*` build args on its own:

```bash
cd /opt/tugpt && git pull
systemctl restart tugpt.service      # runs: compose up -d --build --remove-orphans
```

Then watch it come back:

```bash
docker compose -p tugpt ps
docker compose -p tugpt logs --tail=50 web whatsapp-worker draft-worker caddy
curl -fsS https://dashboard.tugpt.pro/api/v1/health
```

Since 2026-08-26 the unit passes `--profile proxy`, so a restart recycles Caddy
too. Brief, and it reloads the certificate from the `caddy_data` volume rather
than re-issuing.

An explicit `docker compose build` is only needed when building by hand outside
systemd — and then source the env file first (5.4a), because the build args are
declared with `${VAR:?...}` and the build will refuse rather than bake empty
strings into the image.

**Before pulling, check that what you are pulling is safe to deploy.** The
2026-08-25 crash-loop was fixed *on the box* first, which meant `git pull` would
have reverted the fix and taken both workers down. The repo and the running
configuration must never disagree; if you hotfix on the server, land the same
change in the repo before the next pull.

**After any infrastructure change**, re-run the host check:

```bash
sudo sh deploy/check-host.sh         # must stay 0 failed
sh deploy/caddy/check-cert.sh        # certificate + renewal path
```

### 5.6 Explicitly not part of this deployment work

- Langdock production credentials and enabling `ai_draft_generation` are handled separately — the provider work (ADR-006, rotation in PR #23) is merged and `LANGDOCK_MODELS` is set on the server, but turning the feature on is the controlled rollout in `docs/controlled-rollout.md`, not a deployment step. Nothing here changes that.
- `whatsapp_integration` stays `false`. This section covers *where the app runs*, not turning features on. Note the draft worker validates `LANGDOCK_API_CODE` and the model allowlist at boot **only once `ai_draft_generation` is on** — a misconfigured provider is invisible until the flag flips, so plan the flip as a supervised moment rather than a background one.
- **IONOS voice** is not configured. `IONOS_API_KEY` is present and empty; nothing reads it at boot. Configuring the account, filling the value into both env files and restarting is a deliberate step, not part of a release.
- **Logicc is not coming back via an env file.** See section 1.
