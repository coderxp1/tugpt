# Phase 3 — Appointments, slice 1: read-only availability

**Status:** implemented and tested locally. Mock-backed only. No live provider,
no database migration, no booking creation, no WhatsApp wiring, no production
change.

**Branch / worktree:** `feat/appointments-availability-v1` in
`C:\Users\hartm\tugpt-appointments-availability-v1`, based on `upstream/main`
(`440dcae`, PR #5 merged).

**Package:** `@tugpt/appointments`

---

## 1. What this slice does, and what it deliberately does not

It answers one question — *what times is this business actually free?* — from an
authoritative provider, and returns nothing when it cannot know.

The governing rule is Blueprint v1.4 §19.2/§21.2: **never invent availability**.
Three mechanisms enforce it, rather than a comment asking nicely:

1. **The contract reads only.** `CalendarAvailabilityProvider` declares one
   method, `findAvailability`. There is no `createEvent`, `book` or `confirm`.
   Code that cannot write cannot double-book and cannot claim a booking it did
   not make.
2. **Provenance is stamped, not inherited.** The service overwrites the
   provider's `provenance` and `confirmation` on every slot it returns, so a
   provider cannot talk its way into claiming `CONFIRMED`.
3. **Failure is typed and empty.** Every provider failure — outage, rejected
   credentials, missing configuration, malformed payload, even a provider that
   throws — resolves to `{ ok: false, slots: [] }`. The service never rejects,
   so a conversation loop cannot lose a turn to an exception; and it never
   substitutes a plausible time.

`CONFIRMED` exists in the enum so a later booking slice can express it and so
consumers can switch exhaustively. **Nothing in this package can produce it.**

## 2. Files added

```
packages/appointments/
  package.json            workspace conventions (@tugpt/*, vitest, tsc build)
  tsconfig.json           typecheck config, includes tests
  tsconfig.build.json     emit config, excludes tests
  eslint.config.mjs       re-exports the shared root flat config
  src/provider.ts         the read-only contract, slots, failure reasons
  src/time.ts             validation + zone arithmetic via Intl only
  src/availability-service.ts  validate → ask → normalise → stamp
  src/mock-provider.ts    deterministic provider, explicit failure modes
  src/observability.ts    audit seam (no persistence in this slice)
  src/index.ts            public surface
  src/availability.test.ts     27 tests, A5–A31
```

## 3. Design decisions worth recording

**A new package rather than a module in `apps/worker`.** Availability is a
domain capability with a contract a second implementation (a real provider) must
satisfy. `packages/*` is where this repository already puts such things
(`jobs`, `feature-flags`, `ai-providers`), and it keeps the dependency direction
correct: the worker will consume the package, not vice versa.

**No existing abstraction was duplicated.** I checked before creating anything:
`ADR-015` describes `calendar.find_availability` as a *capability*, `ADR-007`
lists `appointment.send_reminder` in `JobType`, and the prompt layer already
carries an anti-invention guardrail. None of these is an availability
implementation — the ADRs specify the shape, this package is the first
implementation of it. No provider adapters, no scheduling code and no calendar
types existed to reuse.

**Zone arithmetic uses `Intl` exclusively.** No home-grown offset table. The
offset is recovered by formatting the instant in the target zone and comparing
against the same wall clock read as UTC, so DST comes from the runtime's own
zone data — the same table the rest of the platform uses. A spring-forward gap
returns `null` rather than offering an hour the business is not open.

**Overlapping duplicates are dropped, not merged.** The canonical example:
09:00–10:00 and 09:30–10:30 must not read as two free appointments. Containment
uses a closed-open `[start, end)` comparison, so adjacent windows do not collide
at the boundary.

**An observer rather than a database write.** Phase 3 requires an audit trail;
this slice may not migrate the schema. The service reports every outcome through
`AvailabilityObserver`, and a later slice supplies a persisting implementation.
A throwing observer is contained — degrading observability must never degrade
the customer's answer.

**Slots outside the window are dropped, not clipped.** A clipped slot is a time
the provider did not offer.

## 4. Verification

Commands, run in the worktree:

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` (package) | exit 0 |
| New tests | `pnpm exec vitest run` (package) | **27 passed** |
| Build | `pnpm exec tsc -p tsconfig.build.json` | exit 0 |
| Lint | `pnpm exec eslint .` | exit 0 |
| Regression | `vitest run` across 9 packages | **524 passed**, 0 failed |

Package totals: appointments 27, ai-providers 238, ai-orchestration 133,
security 73, jobs 15, feature-flags 12, database 10, auth 9, observability 7.

### Mutation checks (do the tests have teeth?)

A passing suite proves nothing on its own, so I broke three guarantees in turn
and confirmed the suite catches each:

| Injected defect | Tests that failed |
|---|---|
| Stamp `CONFIRMED` instead of `SUGGESTED` | 1 |
| Remove the window-containment filter | 1 |
| Return an invented slot alongside a failure | 6 |

The service was restored from a copy each time and re-verified green.

## 5. Coverage map

- **Provider failure** — A5 outage, A6 rejected credentials, A7 missing
  configuration, A8 provider throws, A9 malformed payload, A10 legitimate empty,
  A11 recovery after transient outage.
- **Never `CONFIRMED`** — A12 every slot `SUGGESTED`, A13 provenance and source
  stamped, A14 no slots alongside a failure.
- **Invalid input** — A15 rejected before the provider is called, A16 unknown
  zone, A17 date-only string, A18 non-positive duration, A19 inverted window,
  A20 duration exceeds window, A21 oversized limit capped.
- **Time zones** — A22 same local hour is a different instant per zone (Madrid
  UTC+1 vs Mexico City UTC−6 in January), A23 bounds normalized to UTC with the
  zone retained, A24 DST spring-forward shifts the offset.
- **Determinism and containment** — A25 identical query yields identical answer,
  A26 ascending order, A27 out-of-window slots dropped, A28 wrong-duration
  dropped, A29 limit honoured, A30 audit outcomes recorded, A31 throwing
  observer contained.

## 6. Not done, and why

- **No live provider.** Approved for this slice; mock first.
- **No booking creation.** Requires an authoritative write path, per-tool
  idempotency (ADR-015 §3) and operator approval. Separate slice.
- **No schema or migration.** `local Supabase 58 / hosted 55` is unchanged.
- **No WhatsApp wiring.** The contract must be stable first.
- **No persistence of the audit events.** The seam exists; the writer does not.

## 7. Recommended first real provider

**Google Calendar, read-only, behind the existing feature flag mechanism.**

Reasoning, against the criteria in the handover:

- **Customer value.** A business already running on Google Calendar gets working
  appointments with no migration and no new vendor. That is the largest
  immediately-servable segment, and it exercises `ADR-015`'s
  `calendar.find_availability` capability as specified.
- **Fit with what exists.** `secret_storage` (migration 20260903000003) and the
  feature-flag read path are already in place, so the integration adds an
  adapter and an OAuth callback route rather than new infrastructure.

> **Provider specifics below are UNVERIFIED.** I could not confirm the OAuth
> scope names or the exact endpoints while writing this (web search was
> unavailable). Treat them as a starting hypothesis to check against current
> provider documentation before implementing — not as established fact.

- **Authentication (to verify).** OAuth 2.0 authorization-code with offline
  access. The intent is to request the narrowest scope that can answer "when is
  this business free" without reading event *contents* — Google's free/busy
  query is the candidate, since it returns occupied intervals rather than
  event details. Confirm the exact scope string and whether it satisfies
  least-privilege for this use case.

**Cal.com is the better second choice**, and I would take it before Calendly
because its API is reported to cover availability and booking in one model with
self-hosting, which suits the write path in slice 4. **Calendly** is the weakest
of the three on availability granularity — again, verify before relying on this.

Whichever is chosen, the adapter implements `CalendarAvailabilityProvider` and
nothing else changes.

## 8. Remaining decisions for the owner

1. **Provider sequence** — confirm Google Calendar read-only first, or go
   straight to Cal.com.
2. **Slice 2 shape** — persist appointment requests, suggestions, audit events
   and idempotency keys before any write path exists? Recommended: yes. A
   suggestion the customer was shown is evidence, and it is cheaper to record
   before a booking depends on it.
3. **`MAX_WINDOW_MS`** — currently 31 days, with 20 slots default and 100
   maximum. These are guesses at operational limits, not measurements.
4. **Time-zone source of truth** — the contract takes the zone from the caller.
   Once a real provider is wired, decide whether the zone should instead come
   from the organization's stored locale, to avoid a caller passing a zone the
   business does not operate in.
