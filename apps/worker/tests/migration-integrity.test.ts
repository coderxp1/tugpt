/**
 * Forward-only migration policy: applied migrations are immutable. This test
 * verifies every migration file's SHA-256 against a committed manifest, so any
 * edit to a previously applied migration fails CI. Corrections must use a new
 * migration id (see docs/connect/migration-integrity.md).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');

describe('migration integrity (forward-only)', () => {
  it('every applied migration file matches its committed checksum', () => {
    const manifest = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'checksums.json'), 'utf8')) as Record<string, string>;
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      const hash = createHash('sha256').update(content).digest('hex');
      expect(hash, `migration ${f} was modified after being applied; corrections must use a new migration id`).toBe(manifest[f]);
    }
  });
});
