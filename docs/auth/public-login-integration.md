## P2 reconciliation overlay: opaque Dashboard session, not a second login

P2 is source-only. Preserve canonical verification, existing opaque session/cookie handling and same-UUID identity binding. Do not infer verified email from an empty presentation field, create an account or membership on login/selection, or fetch a hidden canonical bearer. Invitation compatibility retains its own fresh verified-email requirements.

P2-DB-01 changes only delivery-read transport: ordinary authenticated client -> public SSO delivery wrapper -> validated bridge session/current membership/feature gate -> tenant-filtered rows. The browser receives the existing delivery JSON, not a provider credential or signing key. The feature adapter and privileged factory are unchanged. HTTP allowlisting does not substitute for the wrappers' independent DB authorization checks. See `sso-reconciliation.md` for signatures, ACLs, bounds and limitations. No hosted validation or M2 completion is implied.

# Public website to Dashboard authentication integration

Status: implemented and tested in an isolated worktree; NOT deployed. Production approval and account validation required.
Branch: feat/public-login-handoff, based on Dashboard commit 0631cab.

## Read-only findings

Public website: https://tugpt.pro; login: https://tugpt.pro/login.html.
Live auth-config.js selects https://rbiumegrwtavmljxbknp.supabase.co, redirects OAuth back to the public login, and has an empty appUrl.
Live login.js uses PKCE, persistSession, localStorage key tugpt-auth, and getUser verification. Its success handler shows the signed-in panel; even a populated appUrl only enables a link, not an automatic session-aware navigation.
Public provider settings currently enable Google and GitHub. Public signup is enabled. (The initial HTML GitHub-unavailable note is replaced using actual provider settings.)

The redesigned Dashboard at dashboard.tugpt.pro instead uses the self-hosted staging Supabase behind its same-origin auth/REST proxy, with email/password enabled, Google/GitHub disabled and public signup disabled. It uses @supabase/ssr host-only cookies, Secure on HTTPS and SameSite=Lax, and validates identities and membership against staging.

These are separate identity authorities and databases. Sharing the Supabase product does not mean sharing a project. A website localStorage session cannot be read by a subdomain; even copying a production token into a staging cookie would not establish a valid staging identity/membership. No token copying, shared parent-domain cookies, matching by email or account migration is proposed.

Zero-row production REST probes confirmed that profiles, organizations and organization_members are reachable and that the membership query's columns/join shape are accepted. This DOES NOT establish that the intended users have memberships, that the full Dashboard schema is compatible, or that production RLS is correct. No private production accounts or membership rows were read. No production administrative access was available.

## Proposed flow

1. The existing IONOS landing page and login HTML stay where they are; no CSS/layout/hosting change.
2. An opt-in login.js patch sends a selected provider name to /auth/website/start on the Dashboard origin. It retires any legacy public-site session in that browser with local sign-out first. Fresh OAuth uses the same production identities/providers, not imported staging accounts.
3. Dashboard creates PKCE verifier cookies on its own host, then redirects to the configured Supabase provider endpoint.
4. Supabase returns a short-lived authorization code to the fixed /auth/website/callback. No access token, refresh token or password is passed in a URL.
5. Server exchanges the code, verifies getUser, resolves existing organization membership and redirects to /dashboard. Missing membership gets a safe error page; no organization or role is created automatically.
6. Dashboard local sign-out clears its session and revokes that refresh session; errors are shown with retry rather than pretending success. Other devices and the upstream Google/GitHub browser session are not logged out. Already issued access JWTs retain their normal lifetime; instant global JWT revocation is not claimed.

Old public-site OAuth redirect URLs must remain allowed during transition. Legacy browser sessions are not silently shared; users may need one fresh provider round trip. No identity provider change is needed.

## Implemented, inactive changes

- Server-only opt-in start/callback routes with fixed callback/origin, provider allowlist, project configuration consistency guard, no-store/no-referrer responses and generic errors.
- Default disabled unless TUGPT_WEBSITE_LOGIN_ENABLED=true and TUGPT_WEBSITE_AUTH_URL exactly matches NEXT_PUBLIC_SUPABASE_URL.
- Safe post-login destinations for the existing login/callback (reject external URL/protocol-relative/javascript paths).
- Local sign-out scope, checked errors and retry UI.
- IONOS login.js patch and installation instructions under deployment/ionos. No public files uploaded. No live config changed.

## Tests and limitations

- 639 tests in 46 suites passed. TypeScript passed. Production-mode Next build passed. ESLint passed with two existing warnings and no errors. Static patch syntax check passed.
- New contract tests cover disabled flow, project mismatch, invalid app origin/provider, callback destination pinning, provider URL validation, missing/error/token-bearing callbacks, failed code exchange, verified identity, missing membership, safe redirects, logout failure/retry.
- Browser journey: original landing navigation -> existing login HTML with patch -> simulated OAuth consent -> candidate server callback -> real staging identity/session -> redesigned Dashboard with existing org and role -> reload -> sign-out -> protected route denial. Foreign-organization request returned 403. Secure Dashboard-host verifier cookies checked. No access/refresh tokens/passwords in navigation URLs. Code replay rejected by the one-use-code fixture. No uncaught browser JavaScript errors.
- Browser origins were intercepted to private loopback servers. HTTP redirects were asserted then translated to browser navigations by the test transport, so redirected requests could not escape interception. OAuth consent/code issuance was a TEST fixture, not Google/GitHub. Only the staging account/permissions/session APIs were real. This is NOT production OAuth acceptance or a substitute for provider security testing.
- Test fixture and credentials are outside the application. Never deploy the fixture or loopback test configuration. Runtime application changes contain no test bypass.

## Exact approval scope before production work

A. Authorize read-only review of production schema/RLS/memberships and a designated real user with Google/GitHub login. Use secure admin access or a redacted schema/policy export; never paste service-role keys or passwords into chat. No automatic schema migration or role changes.
B. Add exactly https://dashboard.tugpt.pro/auth/website/callback to the EXISTING production Supabase project's allowed redirect URLs. Retain https://tugpt.pro/login.html and existing provider configuration, Site URL and signup settings. Existing Google/GitHub provider callback remains the Supabase /auth/v1/callback; no provider-console change expected unless the current settings reveal a separate restriction.
C. Prepare a separate production-backed Dashboard deployment with production Supabase URL/public key and protected server credentials from that same project. Keep staging database/accounts/reviewer data and its rollback bundle intact. Validate full schema/RLS compatibility first. Do not mix production auth with staging application data.
D. After successful production candidate tests, cut dashboard.tugpt.pro to that deployment. The old staging /auth/v1/* and /rest/v1/* forwarding on that host must be retired as part of cutover; the production candidate uses the existing hosted Supabase URL directly. This is a narrowly scoped Dashboard proxy/app change, NOT DNS or public website hosting migration. Preserve prior configuration for rollback and retain staging privately; staging reviewer credentials do not automatically become production credentials.
E. Only then upload the two-file IONOS patch: backed-up login.js replacement and one dashboardLoginUrl addition to auth-config.js. Keep login.html/index.html/layout/other assets unchanged. Recheck live file hashes before replacing anything. See deployment/ionos/README.md.

No DNS change is currently needed. Do not change DNS, Supabase settings, live Dashboard configuration or IONOS files until the user approves. If schema incompatibilities, missing memberships or policy changes are found, report their exact changes and request additional approval before writing anything.

Production acceptance still required: designated existing user logs in using the actual provider, correct production organization/role is verified, cross-tenant access denied, refresh/reload works, cancellation/expiry/replay handled, sign-out clears session and blocks protected pages. No production account recreation or mutation merely to make a test pass.

## Rollback

Back up both IONOS files and the Dashboard app/proxy configuration. Roll back the website patch before restoring any staging-backed Dashboard public route; never leave production login pointing at staging. Keep the prior production deployment available when performing a production cutover. Preserve existing Supabase identities/data throughout; removing a new redirect allowlist entry is only done after in-flight login flows have drained and with approval.
