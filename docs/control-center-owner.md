# Owner access to the Product Control Center

### Product Control Center

The owner workspace lives on `feat/product-control-center` (PR #19), not on
`main` until that PR is merged. Its page is `/control-center`; implementation:
`apps/web/src/components/control-center`, `apps/web/src/lib/control-center`,
and `apps/web/src/app/api/v1/control-center`.

**Local setup (Node 22 and pnpm 10):**

```bash
git switch feat/product-control-center
pnpm install --frozen-lockfile
pnpm control-center
```

Open **http://localhost:3000/control-center** and paste the **Owner access key**
printed in the terminal. No email, tenant account, Supabase project, workers,
GPU, or paid provider is required. Keep the terminal open; Ctrl+C stops it.
The launcher builds workspace dependencies, starts only the web app, binds to
**127.0.0.1**, and generates a fresh random key on each start. It does not start
workers or expose a public port. Ordinary `pnpm dev` does NOT enable owner
access unless `CONTROL_CENTER_TOKEN` is configured.

**Access policy:** a server-only `CONTROL_CENTER_TOKEN` of at least 24 characters
is required in **every** environment. Unset/short keys give 404; no proof gives
an owner unlock form (401) or API JSON 401. Use a random key, not a password.
The form sends it via a same-origin header, never in a URL. Successful unlock
sets an httpOnly, SameSite=Lax, HMAC-signed cookie with **server-enforced 12-hour
expiry** (Secure over HTTPS). Scripts can send `x-control-center-key`.
**Lock workspace** clears the browser cookie; key rotation invalidates all
sessions. Tenant authentication and RLS are unchanged. Owner access grants
only catalog/health/fixture labs, not access to customer data.

**Remote/staging:** deployment or public availability requires owner approval.
Prefer a loopback listener accessed using an existing SSH login and local port
forwarding; no SSH/Caddy/firewall changes are required. A browser-only hosted
installation needs an approved HTTPS/private-access configuration and secure
key delivery. Never run the dev server on a public interface. Do not put keys
in Git, tickets, URLs, or `NEXT_PUBLIC_*` variables.

Labs label `real-in-process` (production functions over fixtures),
`simulated-provider` (the production service using a mock calendar), or `blocked`.
They send no WhatsApp messages, call no AI/calendar/media provider, and write no
tenant data. Health may probe the configured Supabase Auth health endpoint;
this is NOT a database/RLS/schema test. Worker liveness is explicitly unknown.

