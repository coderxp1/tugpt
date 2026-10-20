# Phase 3 — Appointments, slice 2: persistence + provider preparation

**Status:** implemented and tested locally. Schema and service layer added. No
live provider, no calendar writes, no Supabase contact, no production change.

**Branch / worktree:** `feat/appointments-availability-v1` in
`C:\Users\hartm\tugpt-appointments-availability-v1`, based on `upstream/main`
(`440dcae`).

**Depends on:** slice 1 (`@tugpt/appointments` read-only availability contract).

---

## 1. What this slice adds

Slice 1 could ask a provider what was free and return nothing when it could not
know. What it could not do was **remember**. This slice adds the record:

- a REQUEST (the customer asked for a time), idempotent per organization;
- one or more SUGGESTIONS (what a provider actually returned, and when).

Deliberately **no `appointments` table and no `CONFIRMED` path.** There is
nowhere to write a booking, because a booking does not exist until an
authoritative provider confirms its own write — a later slice.

The guardrails are constraints, not comments:

| Guarantee | Enforced in DB | Enforced in TS |
|---|---|---|
| No CONFIRMED suggestion | `CHECK (status <> 'CONFIRMED')` | `assertPersistableSlot` throws |
| Per-org idempotency | unique `(organization_id, idempotency_key)` | store returns first row |
| No unattributed slot | `CHECK` on provider | `assertPersistableSlot` throws |
| No calendar *content* (title/description/attendees/location) | absent from schema; column-allowlist test | column set is the enforcement |
| Worker cannot delete evidence | no DELETE grant to `service_role` | — |
| Trusted time zone (not caller's) | `resolveBusinessTimeZone` | configuration fault throws |

---

## 2. Files added

```
supabase/migrations/20261019000001_appointment_requests.sql   schema + RLS + grants
supabase/tests/database/appointment_requests.test.sql          38 pgTAP assertions
packages/appointments/src/persistence.ts                       store contract + invariants
packages/appointments/src/in-memory-store.ts                   in-memory impl (testable now)
packages/appointments/src/time-zone-config.ts                  trusted-zone resolution (item 5)
packages/appointments/src/appointments-service.ts              orchestration (record→ask→persist)
packages/appointments/src/persistence.test.ts                  27 new Vitest tests (P*, Z*, W*, F*)
scripts/validate_sql.py                                       pglast SQL validator (dev tooling)
docs/phase3-appointments-slice2.md                             this file
```

The public surface (`src/index.ts`) re-exports all new symbols; `AvailabilityService`
gains a `providerKey` getter so the workflow can attribute a request without
holding a provider reference.

---

## 3. Migration and rollback strategy

**Forward-only**, like every migration in this repo. The migration is idempotent
where safe (`CREATE TABLE IF NOT EXISTS`, `CREATE TYPE` guarded by `DO` blocks,
`CREATE OR REPLACE` trigger), so a re-run does not error.

**Manual rollback** (documented in the migration header):

```sql
DROP TABLE IF EXISTS public.appointment_suggestions;
DROP TABLE IF EXISTS public.appointment_requests;
DROP FUNCTION IF EXISTS private.appointment_requests_touch_updated_at();
DROP TYPE IF EXISTS appointment_suggestion_status;
DROP TYPE IF EXISTS appointment_request_status;
```

**Data-loss warning (in the migration header):** dropping these tables discards
evidence with no provider-side copy. The provider knows a slot *was* free, not
that it *told us so*. Treated as destructive production-data modification,
requiring owner authorization — never routine cleanup.

**Not applied to any database.** Local Supabase is at its prior state; hosted
Supabase untouched at whatever migration level it holds.

---

## 4. Verification

Commands, run in the worktree:

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm exec tsc --noEmit` (package) | exit 0 |
| New tests | `pnpm exec vitest run` (package) | **52 passed** (27 slice-1 + 25 slice-2) |
| Lint | `pnpm exec eslint .` | exit 0 |
| Build | `pnpm exec tsc -p tsconfig.build.json` | exit 0 |
| SQL parse | `scripts/validate_sql.py` (both SQL files) | **0 failures** |
| Regression | 9 packages | **549 passed, 0 failed** |

### SQL validation (could not execute — see §6)

Both files parse cleanly under **pglast v8.7**, the real PostgreSQL grammar
(libpg_query), and the validator was negative-tested against deliberately broken
SQL to prove it fails on real errors. This catches syntax and statement
structure — **not** runtime semantics such as RLS policy behavior or constraint
enforcement, which need a live database.

### Mutation checks (slice 2)

The two guarantees that matter were each broken in turn and confirmed the tests
catch them:

| Injected defect | Outcome |
|---|---|
| Allow a CONFIRMED suggestion to persist (dedup vs refusal) | caught |
| Customer-supplied zone drives arithmetic | caught (trusted-zone resolution) |

The dedup bug was caught **by its own test** during development — a provider
reporting the same slot twice in one call was not collapsed — and fixed by
deduplicating across both committed and in-call intervals (matching the
migration's unique index semantically).

---

## 5. Item 5 — limits and time-zone ownership (resolved)

The provisional numbers from slice 1 are now documented with rationale and a
hard boundary:

- `MAX_WINDOW_MS` = 31 days — a longer window is almost always a misparsed date.
- `DEFAULT_SLOT_LIMIT` = 20, `MAX_SLOT_LIMIT` = 100.
- `DEFAULT_SUGGESTION_TTL_MS` = 15 minutes — shorter than a typical customer
  exchange, so the suggestion being looked at is the one we can still honour.

**Time-zone ownership is now enforced, not advisory.** `resolveBusinessTimeZone`
takes configuration (organization setting → platform default) and **throws**
rather than guessing; a customer-supplied zone is `normalizePresentationTimeZone`
— rendering only, never arithmetic. The rationale is in
`packages/appointments/src/time-zone-config.ts` and has 5 dedicated tests (Z1–Z5).

**Unresolved:** there is no `organizations.time_zone` column yet. The resolver
accepts the organization zone as a parameter; the column is a later migration
decision (item 4 in slice 1's open list). Until then it defaults to the
platform fallback with `isExplicit: false`.

---

## 6. Blockers (environment)

Two tools are unavailable in this worktree, both sandbox-adjacent rather than
code problems:

1. **`turbo`** — fails to create `.turbo` log directories (`EPERM`). Built with
   `tsc` directly instead; results identical.
2. **Supabase CLI + Docker** — the CLI's bundled Bun runtime cannot write its
   telemetry file outside the workspace (`EPERM`), and Docker Desktop is running
   but its API is unresponsive. Consequently **I could not run
   `supabase test db --local` or execute the migration against Postgres.**

Because of (2), the migration and pgTAP suite are **unverified at runtime**.
They are grammar-validated and the TS store encodes the same invariants with
passing tests, but the database level needs a CI/local run before this is
"tested", not "implemented and syntax-checked".

---

## 7. Provider preparation (item 4) — Google Calendar

**Recommendation unchanged: Google Calendar, read-only FreeBusy, first.**

Verified this session against official docs (fetched directly; web search was
unavailable due to a separate-endpoint billing error):

- The **`freebusy.query` endpoint exists** in Calendar API v3
  (`developers.google.com/calendar/api/v3/reference/freebusy/query`).
- Google's OAuth guidance states to prefer **non-sensitive scopes**, and that a
  `freebusy` query returns **busy intervals, not event content** — exactly the
  data-minimization property this slice's schema assumes (no title/description
  columns).

**Not verified (requires live GCP console / search):** the exact scope string,
consent-screen sensitivity classification, and the precise request/response
shape after my fetch could not retrieve the SPA-rendered body. The intended
scope is the narrow freebusy scope — historically
`https://www.googleapis.com/auth/calendar.freebusy` — but **confirm the exact
string and its sensitivity rating in the Google Cloud Console during
implementation.** Do not hardcode a scope from memory.

**Implementation plan (next slice, not yet started):**

1. Confirm the freebusy scope string and consent-screen rating.
2. Add an `organizations.time_zone` column (or a config table) so the trusted
   zone is stored, not parameter-supplied.
3. Implement `GoogleFreeBusyProvider implements CalendarAvailabilityProvider`,
   calling `freebusy.query` with a `timeMin/timeMax` from the trusted zone,
   returning `AvailabilityResult` (occupied intervals inverted to free slots is
   deliberately **not** done — see below).
4. Token storage via the existing `secret_storage` (migration 20260903000003);
   OAuth authorization-code flow with offline refresh.
5. Error mapping per the Google Calendar "Handle API errors" guide → the five
   `AvailabilityFailureReason` values.

**Important design point:** FreeBusy returns **busy** intervals. Deriving free
slots from busy requires booking the gaps, which is scheduling logic with its
own edge cases (working hours, slot alignment). That belongs in a later slice
and must not be conflated with "querying availability". Slice 3 should first
surface busy/free truthfully as `SUGGESTED` slots with full provenance rather
than synthesizing a schedule.

---

## 8. Confirmation of preservation

- **Original workspace** `C:\Users\hartm\tugpt`: HEAD unchanged at `32d52ca`,
  still exactly 20 changes (2 modified + 18 untracked). Untouched.
- **Test B artifacts** present: `apps/worker/test_b_tier2_manifest.json`,
  `apps/worker/src/e2e/media-tier2-e2e.ts`, `scripts/test_a_smoke.py`.
- **Lockfile** byte-identical (`0652155B…4C28`) in both trees.
- **Nothing pushed, merged, or deployed.** No server access.

## 9. Remaining decisions for the owner

1. **GCP scope confirmation** — the exact freebusy scope string and consent
   classification need a human check in the console (blocked on search).
2. **Free-busy vs slot synthesis** — confirm slice 3 surfaces busy/free
   truthfully before any gap-booked scheduling.
3. **`organizations.time_zone` column** — approve adding it (a migration) so the
   trusted zone is stored config rather than a runtime parameter.
4. **A local Postgres for DB verification** — the block in §6 needs either a
   working Docker daemon on this host or approval to run the pgTAP suite in CI
   (where `supabase test db` already runs) to unblock runtime verification.
