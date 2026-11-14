> **Status update 2026-11-01:** the domain decision in this ADR is superseded. `tugpt.app` is not part of the TuGPT setup; canonical domains are `tugpt.pro`, `dashboard.tugpt.pro` and `workspace.tugpt.pro`. The product-name decision (TuGPT, no TLD in the brand) stands.

# ADR-016: The Product Name Is "TuGPT"; the Domain Is Configuration

## Status
Accepted

## Context
On 2026-08-28 control of the `tugpt.ai` registration was lost. `tugpt.app` was
pointed at `212.227.44.13` and became canonical. The old domain is to be treated
as hostile: whoever holds it can answer any challenge sent to it, and until
every allowlist entry naming it is revoked, it can be handed credentials meant
for us.

Switching the deployment took one environment variable. `deploy/caddy/Caddyfile`
hardcodes no hostname — its site address is
`{$TUGPT_DOMAIN:TUGPT_DOMAIN-is-not-set.invalid}`, read from
`/etc/tugpt/web.env` — so the proxy followed `TUGPT_DOMAIN` and a restart.

Everything else was expensive, and the reason is worth recording rather than
absorbing. The product had been *named* `TuGPT.ai`, with the TLD attached, and
that name was spelled out independently in fourteen places. Two of them were on
a customer's screen: `apps/web/src/app/layout.tsx` (the browser tab title) and
`apps/web/src/app/auth/login/page.tsx` (the login heading). Neither read from
`APP_CONFIG`; each held its own copy of the string. A brand that contains a
hostname turns every rename of that hostname into a code change, and a name
duplicated across files guarantees the rename is incomplete.

The audit that found all of this needed two passes. A literal grep for
`tugpt.ai` missed an escaped `tugpt\.ai` in a shell fixture's regex assertions
and a hyphenated `tugpt-ai` in `supabase/config.toml`. Both surfaced only
because fixtures went red and a second, looser sweep was run.

## Decision
1. **The product name is `TuGPT`. It carries no TLD, in code, in UI, in
   configuration, or in document titles.** `.app` is not a substitute for `.ai`
   here; putting any TLD back in the brand re-arms the same trap.
2. **`apps/web/src/config/locales.ts` (`APP_CONFIG.name`) is the single source of
   the product name in the web application.** Components read it. They do not
   spell it. `apps/web/tests/app-config.test.ts` pins both `APP_CONFIG.name` and
   the root metadata title to `TuGPT`, so the browser tab cannot drift from the
   config the way it did before. That test does not — and cannot cheaply —
   prove no component anywhere holds its own copy; what catches a copy carrying
   the *dead* domain is the guard in point 4, and what catches one carrying a
   live-but-stale name is review.

   *Amended 2026-08-30 by ADR-017.* The layout now exports `generateMetadata()`
   rather than a static `metadata` object, because the page description became a
   translated string. The test pins `generateMetadata().title`. The guarantee is
   unchanged; only the export it names.
3. **The domain is deployment configuration, not identity.** `TUGPT_DOMAIN` in
   `/etc/tugpt/web.env` is the only place the deployed hostname is written. No
   repository file hardcodes it. Changing where TuGPT is served must never
   require a code change.
4. **`tugpt.ai` must not appear in any runtime or deployment path.**
   `apps/worker/tests/no-dead-domain.test.ts` enforces this in CI and matches
   every spelling the hand audit missed — dotted, regex-escaped, hyphenated and
   underscored — while excluding the `@tugpt/ai-*` workspace package names.
   Exemptions live in a keyed allowlist where each entry states the standing
   instruction or repository rule that forbids the edit, and the suite fails when
   an exemption goes stale.
5. **`docs/` and `docs/adr/` are deliberately outside that guard.** The incident
   has to be describable, and a rule that forbade naming the lost domain in prose
   would make it undocumentable.
6. **Context sections in ADR-001, -002, -003, -008, -010 and -011 keep the old
   name and are not edited.** They record what was true when written; this ADR
   supersedes the name for every reader who reaches them. A decision record
   quietly rewritten to match the present is worth less than a dated one.

## Consequences
- Renaming the deployment hostname is now an env edit and a restart. Only the
  out-of-repository allowlists — Supabase Auth URL configuration and the Meta
  webhook callback — need human action, and both are enumerated in
  `docs/production_environment.md` §5.4c.
- The web application's displayed name changes in exactly one file.
- `tugpt.app` is on the HSTS preload list, so there is no degraded-but-reachable
  state if TLS ever fails: the site is either served over HTTPS or it is gone.
  That is a deliberate trade — the failure is loud rather than silent — and it
  makes `deploy/caddy/check-cert.sh` and its weekly cron entry load-bearing
  rather than optional.
- Fixture email addresses still using the dead domain are exempted today and
  scheduled to become `example.com` (RFC 2606) in the follow-up to PR #47. A real
  domain in a fixture is the underlying defect; swapping one live domain for
  another would repeat it.

---

## Amendment (2026-11-12): canonical domain for vendor callbacks

Owner decision: **`tugpt.pro` is canonical.** New vendor app registrations and
OAuth callbacks use `dashboard.tugpt.pro` (see
`docs/connect/redirect-uris.md`). `tugpt.app` must not be used for new
registrations or callbacks. Existing registrations are unchanged until
separately migrated. No DNS change is made by this amendment.
