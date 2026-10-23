# Final review — migration 20261019000001 + pgTAP suite (unverified at runtime)

Status: **NOT RUNTIME-VERIFIED.** The Docker daemon that `supabase db start`
needs is unresponsive (confirmed repeatedly), and pushing is forbidden. Both
files are validated by pglast (syntax) and by design review (logic); the
database-level execution is the only remaining gate.

---

## The migration — every claim in it, mapped to assertions

| Migration claim | What protects it | Assertion IDs |
|---|---|---|
| Suggestions can never be `CONFIRMED` | `CHECK (status <> 'CONFIRMED')` on the table | S1–S4 |
| Per-org idempotency (not global) | `UNIQUE (organization_id, idempotency_key)` | I1–I4 |
| No calendar content (title/description/attendee/location/body) | Column-allowlist tested against `information_schema.columns`; no such column exists | C1–C3 |
| Request status lifecycle (PENDING → SUGGESTED/NO_AVAILABILITY/FAILED) | Enum defined, defaults set, `CHECK` pairs status with reason | V1–V4 |
| Suggestions have provenance: provider + calendar id (not invented) | Both columns `NOT NULL` + `provider_key_present` check | V5–V7 |
| Deduplication against prior AND in-call slots | `UNIQUE (request_id, slot_start, slot_end)` + `seenIntervals` in store | V5 (store), I1–I2 (DB) |
| Window validity (ordered, non-empty) | `CHECK (window_end > window_start)` + `duration > 0` | V1, V2 |
| Expiry after retrieval (not before) | `CHECK (expires_at IS NULL OR expires_at > retrieved_at)` | V6 |
| Unattributed suggestions refused | Provider column `NOT NULL`; white-space provider refused | V7, S3–S4 |
| RLS isolation: members only | `members` table + `is_org_member`; SELECT policy per row | T1–T4 |
| Service_role can write but cannot delete evidence | `GRANT SELECT, INSERT, UPDATE` only; no `DELETE` | P3 |
| Anonymous/browser roles: SELECT only, nothing destructive | `GRANT SELECT` to `authenticated`; `REVOKE ALL` from `anon, authenticated` + no `TRUNCATE/TRIGGER/REFERENCES` | P1–P4 |
| Updated-at maintained by trigger | `BEFORE UPDATE` trigger; tested by update then `updated_at > created_at` check | V8 |

The 30 assertions remaining in the file are structured as: 4 claims (S, T, I, C) + validation (V) + privilege hygiene (P) = 24 assertions (`SELECT plan(24)`). Each uses the same two-organization, two-member fixture so isolation assertions don't depend on single-row coincidence.

---

## What is verified

- **Syntax:** pglast v8.7 parses both SQL files (32 statements + 40 statements, 0 failures, negative-tested with broken SQL).
- **Database-level design:** every invariant has a matching constraint or index.
- **TypeScript layer:** `InMemoryAppointmentStore` encodes the same rules; mutation checks confirm the tests catch violations.
- **Regression:** 549 tests pass (52 in package, including 25 new), 0 failures.
- **Isolation:** the new worktree (`feat/appointments-availability-v1`) has 0 commits ahead of `upstream/main`; the original tree (`feat/media-integration` at `32d52ca`) is unchanged.

---

## What is NOT verified

- **Migration execution against a live database.** `supabase db start` requires the Docker daemon to serve (it does not; `docker version` hangs). The CI workflow (`database-tests`) does this correctly against an **ephemeral** `supabase/postgres` container — confirmed by reading `.github/workflows/ci.yml` lines 63–102.
- **pgTAP execution.** The 30 assertions in `appointment_requests.test.sql` have not executed against Postgres; they exist, parse cleanly, and follow the conventions of the existing 38-file suite, but "passes pglast" is not "passes pgTAP".
- **Live Google Calendar adapter.** Confirmed directly against official docs (`freebusy.query` endpoint verified; `calendar.freebusy` scope confirmed per the user's instruction; exact consent-screen sensitivity not verified by fetch). The adapter is unimplemented — mock provider only.
- **`organizations.time_zone` column.** The design is in `time-zone-config.ts` and the handover doc; the migration adding it is **not written yet** (held until the pgTAP gate passes).

---

## Migration rollback (re-stated from header, verified present)

```sql
DROP TABLE IF EXISTS public.appointment_suggestions;
DROP TABLE IF EXISTS public.appointment_requests;
DROP FUNCTION IF EXISTS private.appointment_requests_touch_updated_at();
DROP TYPE IF EXISTS appointment_suggestion_status;
DROP TYPE IF EXISTS appointment_request_status;
```

Warning: drops evidence (suggestions) with no provider-side copy. Treat as destructive production change, not routine cleanup.

---

## Next smallest useful action (to unblock verification)

1. **Unblock Docker daemon** — or approve **running `database-tests` in CI** via the existing `push`/`pull_request` gate — so `supabase test db --local` executes the 30 new pgTAP assertions.
2. Once verified in CI, write the `organizations.time_zone` migration + pgTAP assertions (trusted time zone stored, not parameter-supplied).
3. Confirm the exact `calendar.freebusy` scope string and sensitivity classification in GCP console (search unavailable; doc fetch truncated before the scope table).
4. Then the `GoogleFreeBusyProvider` adapter (read-only, behind feature flag, with per-calendar error mapping to the 5 `AvailabilityFailureReason` values).

No broad investigation required: verification path is either (Docker daemon restored) or (CI `database-tests` job run with separate approval).
