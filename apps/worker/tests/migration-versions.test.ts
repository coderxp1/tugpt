/**
 * Migration versions are the ledger key. `supabase_migrations.schema_migrations`
 * stores the bare 14-digit version, so two files with the same version
 * prefix cannot both be recorded. The CLI treats the second one as already
 * applied, and it is silently never run. Committed migrations are frozen
 * (migration-integrity.test.ts), so a collision can only be fixed by
 * renumbering the file that has not been applied anywhere yet. This test
 * makes a collision fail CI on the branch that combines them, before it can
 * reach a database. See docs/workspace/operations.md section 1 (B-2).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;

describe('migration versions (ledger keys)', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  it('every migration file is <14-digit version>_<snake_case name>.sql', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !NAME.test(f))).toEqual([]);
  });

  it('no two migrations share a version', () => {
    const byVersion = new Map<string, string[]>();
    for (const f of files) {
      const v = NAME.exec(f)?.[1];
      if (v) byVersion.set(v, [...(byVersion.get(v) ?? []), f]);
    }
    const duplicates = [...byVersion.values()].filter((names) => names.length > 1);
    expect(duplicates, 'duplicate migration versions: the ledger would record only one of each; renumber the one not yet applied anywhere').toEqual([]);
  });
});
