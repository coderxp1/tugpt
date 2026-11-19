# Migration integrity (forward-only policy)

Applied migrations are **immutable**. Once a migration has shipped to any
environment, its file must never change. A correction to an applied migration
is itself a new migration with a new id.

## Rules

1. Corrections use a **new migration id** (never edit an existing file).
2. `apps/worker/tests/migration-integrity.test.ts` verifies every migration
   file's SHA-256 against `supabase/migrations/checksums.json`; editing an
   applied migration fails CI.
3. To regenerate the manifest after adding a **new** migration (allowed):
   `node scripts/update-migration-checksums.cjs` (or recompute the SHA-256 of
   each `.sql` under `supabase/migrations` into `checksums.json`).

## Upgrading environments with divergent histories

If an environment has been partially migrated out-of-band (e.g. applied via
`psql` rather than the migration tool) and its `supabase_migrations` history is
out of sync with the files on disk, do **not** reset or hand-edit history.
Recovery order:

1. Take a full `pg_dump` backup and verify it restores.
2. Run a schema diff between the live schema and the migrations to confirm the
   schema matches the intended end state.
3. Reconcile history only with the migration tool (`supabase migration repair
   --status applied <version>`), never by hand-inserting rows.
4. Re-run the schema diff to confirm no drift.

Never delete audit or approval rows to make a constraint pass; map invalid
legacy rows to a documented value in a new migration, or leave them for manual
review behind a `NOT VALID` constraint.
