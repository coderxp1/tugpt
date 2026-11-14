# Non-production SSO verification — GitHub → explicit Google link

**Scope:** non-production Supabase project `andyyuwynkwivuwuhxab` only.
**Production (`rbiumegrwtavmljxbknp`, `tugpt.pro`) is not touched by anything in
this document.**

This is the runbook for the approved journey:

1. Sign in with GitHub → welcome/dashboard.
2. Explicitly link Google to the *same* account.
3. Verify the canonical Supabase UUID is unchanged.
4. Sign out.
5. Sign in with Google independently.
6. Verify the same UUID and the same organization membership.
7. Refresh, session persistence, sign-out.

The code for steps 2 and 5 shipped in `feat/auth-identity-linking`
(`/dashboard/settings/accounts`, `supabase.auth.linkIdentity`). What remains is
provider configuration — the one part that genuinely needs the account owner.

## 1. Why this is not fully automatable from the engineering side

Creating a GitHub OAuth App and a Google OAuth client requires signing in as the
owner of those accounts. Enabling providers and manual linking in Supabase
requires owner credentials for the Supabase project. Neither can be done with a
repository, a terminal, or a service-role key, so this document exists to make
the owner's part a five-minute checklist instead of an investigation.

Everything after that — running the app, exercising the journey, collecting
evidence — is engineering work and should not be handed back.

## 2. Required configuration (owner, one time)

### 2.1 Supabase → Authentication → Providers

| Provider | Setting |
|---|---|
| GitHub | Enabled; Client ID + Client Secret from 2.2 |
| Google | Enabled; Client ID + Client Secret from 2.3 |

### 2.2 GitHub OAuth App

- **Homepage URL:** `http://localhost:3000`
- **Authorization callback URL:** `https://andyyuwynkwivuwuhxab.supabase.co/auth/v1/callback`

The callback points at Supabase, not at the app: Supabase is the OAuth client,
and the app receives the session through `/auth/callback` after Supabase
redirects back.

### 2.3 Google OAuth client (Web application)

- **Authorised JavaScript origin:** `http://localhost:3000`
- **Authorised redirect URI:** `https://andyyuwynkwivuwuhxab.supabase.co/auth/v1/callback`

### 2.4 Supabase → Authentication → URL configuration

- **Site URL:** `http://localhost:3000`
- **Additional redirect URLs:** `http://localhost:3000/auth/callback`

Without this entry the provider round trip ends on Supabase's error page
instead of the app.

### 2.5 Manual linking must be enabled

`supabase.auth.linkIdentity()` is refused unless the project has identity
linking enabled (`enable_manual_linking` in the auth config; in the dashboard it
is **Authentication → Providers → Manual linking**, or **Authentication →
Settings** depending on dashboard version). Verify it is on before running the
journey — the failure mode is an unhelpful generic error from the SDK.

### 2.6 Local environment

`.env.local` in the repo root, with the **non-production** values:

```
NEXT_PUBLIC_SUPABASE_URL=https://andyyuwynkwivuwuhxab.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<non-prod anon key>
```

Never the production project's values, and never a service-role key in a
`NEXT_PUBLIC_*` variable.

## 3. Running the journey

```bash
pnpm install --frozen-lockfile
pnpm exec turbo dev          # or: pnpm --filter web dev
```

Then, in one browser profile (one cookie jar — the whole point is one session):

1. Open `http://localhost:3000/auth/login`.
2. **Continue with GitHub**, authorise. Land signed in.
3. Open `/dashboard/settings/accounts`. Record the canonical UUID shown.
4. **Link Google**, authorise. Return to the same page.
5. Confirm the UUID is *identical* and both providers are listed.
6. Open `/dashboard/inbox` — the organization name in the header is unchanged.
7. Reload the page. Still signed in, same org.
8. `/auth/logout`. Confirm the login page.
9. **Continue with Google**. Land signed in.
10. Confirm `/dashboard/settings/accounts` shows the same UUID and both
    providers.
11. Reload; sign out again.

Criterion for steps 5 and 10 is not "it looks right": it is the UUID string
matching character for character, and the organization name matching.

## 4. Evidence collection

Run `scripts/sso-identity-evidence.sql` against the **non-production** database
(psql with the non-prod connection string, or the Supabase SQL editor):

```bash
psql "$SUPABASE_DB_URL_NONPROD" -v email='owner@example.com' \
  -f scripts/sso-identity-evidence.sql
```

It fails loudly (`RAISE EXCEPTION`) on the two conditions that matter:

- more than one `auth.users` row for the email, and
- identities claiming that email belonging to more than one user.

Those are the "accidental duplicate customer account" conditions the owner's
identity rules forbid. Everything else it prints for the record: the canonical
UUID, each provider's subject, and the organization membership.

## 5. Acceptance checklist

| # | Check | Evidence |
|---|---|---|
| 1 | GitHub sign-in produces a session | browser step 2 |
| 2 | `/dashboard/settings/accounts` renders the canonical UUID | screenshot / UUID |
| 3 | Google link succeeds and adds a second identity row | step 4 + `auth.identities` query |
| 4 | UUID after linking is unchanged | steps 3 vs 5, string equality |
| 5 | Organization membership unchanged | header + `organization_members` query |
| 6 | Refresh preserves session | step 7 |
| 7 | Logout clears session | step 8 |
| 8 | Independent Google sign-in resolves to the same UUID | step 10 |
| 9 | Exactly one `auth.users` row for the email | SQL assertion |
| 10 | No identity with that email belongs to another user | SQL assertion |

**Explicitly NOT tested by this runbook:** the separate-customer
account-switching scenario. It requires a second verified identity and is not
authorized; it must be reported as NOT TESTED, not inferred from the above.

## 6. Known limits of this verification

- It runs on `localhost` against the non-production project. It is not a
  production SSO acceptance and must not be reported as one.
- Supabase's manual-linking setting is a project-level toggle; flipping it on
  non-production is safe, but the same toggle on production would be a
  production change requiring separate approval.
- If a provider refuses linking with "identity already exists", that means the
  Google account is already attached to a *different* Supabase user. That is a
  real finding about the account, not a bug in the flow: do not work around it
  by merging users.
