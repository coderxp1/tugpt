/**
 * Forward-only migration policy for THIS repository: applied migrations are immutable
 * (docs/connect/migration-integrity.md). Runs the single implementation, scripts/migration-integrity.cjs,
 * against the real supabase/migrations directory.
 *
 * The previous version of this test looped over the files on disk and compared each to the manifest. It
 * could not see a deleted migration (no file, no loop iteration), an orphan manifest entry, or an edit
 * whose checksum was recomputed in the same change. Those need git: the dedicated `migration-integrity`
 * CI job runs `verify --base <merge-base> --history` with full history. Here:
 *   - the consistency layer always runs (works in the shallow checkout of build-and-test);
 *   - the history layer runs when the clone has full history, and is reported - not silently passed -
 *     when it does not.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(process.cwd(), '..', '..');
const TOOL = join(REPO_ROOT, 'scripts', 'migration-integrity.cjs');

function verify(...args: string[]) {
  const env = { ...process.env };
  delete env.MIGRATION_INTEGRITY_ANCHOR; // the real anchor only
  const r = spawnSync(process.execPath, [TOOL, 'verify', ...args], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const isShallow = () => {
  const r = spawnSync('git', ['-c', 'safe.directory=*', 'rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status !== 0 || r.stdout.trim() !== 'false';
};

describe('migration integrity (forward-only) - this repository', () => {
  it('manifest and migration files agree exactly (no missing, orphan, edited, duplicate or misnamed entries)', () => {
    const r = verify();
    expect(r.out, r.out).toMatch(/^OK$/m);
    expect(r.code, r.out).toBe(0);
  });

  it('no migration was deleted, modified or re-hashed in any commit since the manifest anchor', (ctx) => {
    if (isShallow()) {
      // build-and-test checks out depth 1. Not a pass: the migration-integrity CI job (fetch-depth: 0) owns this.
      console.warn('[migration-integrity] shallow clone: history layer runs in the migration-integrity CI job');
      ctx.skip();
      return;
    }
    const r = verify('--history');
    expect(r.out, r.out).toMatch(/^OK$/m);
    expect(r.code, r.out).toBe(0);
  });
});
