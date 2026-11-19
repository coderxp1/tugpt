/**
 * @file migration-integrity-ci.test.ts
 * @description Keeps the forward-only migration gate wired up:
 *   - ci.yml has a `migration-integrity` job with a full-history checkout that runs the CI script, with
 *     the event refs passed through `env:` only (never `${{ }}` inside a `run:` line);
 *   - nothing under .github/ sets the test-only MIGRATION_INTEGRITY_ANCHOR;
 *   - .github/CODEOWNERS assigns an owner to every path the policy depends on (last matching rule wins);
 *   - the CI script itself, executed for real with `sh`, fails closed on every bad input, and - on a
 *     full-history clone of this repository - passes clean and fails an edit-and-rehash.
 * Hand-parsed on purpose, like ci-triggers-every-pull-request.test.ts: no YAML dependency to vanish.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(process.cwd(), '..', '..');
const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'migration-integrity-ci.sh');
const tmpRoots: string[] = [];
afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }); });

/** The text of one top-level job: from `  <name>:` to the next two-space-indented key. */
function jobBlock(yaml: string, name: string): string | null {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('ci.yml: migration-integrity job', () => {
  const job = jobBlock(CI, 'migration-integrity');

  it('exists and checks out full history without persisted credentials', () => {
    expect(job, 'ci.yml must define a migration-integrity job').not.toBeNull();
    expect(job).toMatch(/uses: actions\/checkout@v4\n\s+with:\n(\s+\S.*\n)*?\s+fetch-depth: 0/);
    expect(job).toMatch(/persist-credentials: false/);
    expect(job).toMatch(/contents: read/);
  });

  it('runs the CI script with refs passed via env, not interpolated into the shell', () => {
    expect(job).toMatch(/run: sh \.github\/scripts\/migration-integrity-ci\.sh/);
    expect(job).toMatch(/PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    expect(job).toMatch(/PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
    for (const l of (job ?? '').split('\n').filter((x) => /^\s+run:/.test(x))) expect(l).not.toContain('${{');
  });

  it('never sets the test-only anchor override anywhere under .github/', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    for (const f of walk(join(REPO_ROOT, '.github'))) {
      if (f.endsWith('migration-integrity-ci.sh')) continue; // the script only REFUSES it
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/MIGRATION_INTEGRITY_ANCHOR\s*[:=]/);
    }
  });
});

/** Minimal CODEOWNERS matcher: anchored patterns, trailing-slash directories, `*` within a segment. */
function ownersFor(codeowners: string, file: string): string[] | null {
  let owners: string[] | null = null;
  for (const raw of codeowners.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...who] = line.split(/\s+/);
    const body = pattern.replace(/^\//, '');
    const re = body.endsWith('/')
      ? new RegExp(`^${body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}`)
      : new RegExp(`^${body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}(/|$)`);
    if (re.test(file)) owners = who; // last match wins, including an ownerless rule
  }
  return owners;
}

describe('.github/CODEOWNERS', () => {
  const co = readFileSync(join(REPO_ROOT, '.github', 'CODEOWNERS'), 'utf8');
  const required = [
    'supabase/migrations/20261120000002_mcp_snapshot_versioning.sql',
    'supabase/migrations/29991231000000_any_future_migration.sql',
    'supabase/migrations/checksums.json',
    'scripts/migration-integrity.cjs',
    'scripts/update-migration-checksums.cjs',
    'apps/worker/tests/migration-integrity.test.ts',
    'apps/worker/tests/migration-integrity-tool.test.ts',
    'apps/worker/tests/migration-integrity-ci.test.ts',
    'docs/connect/migration-integrity.md',
    '.github/workflows/ci.yml',
    '.github/scripts/migration-integrity-ci.sh',
    '.github/CODEOWNERS',
  ];
  it.each(required)('%s has a code owner', (f) => {
    const o = ownersFor(co, f);
    expect(o, `${f} must match a CODEOWNERS rule`).not.toBeNull();
    expect(o!.length, `${f}: the last matching rule must name an owner`).toBeGreaterThan(0);
    for (const x of o!) expect(x).toMatch(/^@[A-Za-z0-9-]+(\/[A-Za-z0-9_.-]+)?$/);
  });
  it('matcher positive control: an unrelated path has no owner', () => {
    expect(ownersFor(co, 'apps/web/src/app/page.tsx')).toBeNull();
  });
});

function runCi(cwd: string, env: Record<string, string>) {
  const r = spawnSync('sh', [SCRIPT], { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('migration-integrity-ci.sh fails closed on bad input (executed with sh)', () => {
  const Z = '0'.repeat(40);
  it.each([
    ['unknown event', { EVENT_NAME: 'workflow_dispatch', PR_BASE_SHA: 'a'.repeat(40) }],
    ['missing event', { PR_BASE_SHA: 'a'.repeat(40) }],
    ['empty PR base', { EVENT_NAME: 'pull_request', PR_BASE_SHA: '' }],
    ['injection attempt', { EVENT_NAME: 'pull_request', PR_BASE_SHA: '$(touch /tmp/pwned);x' }],
    ['short sha', { EVENT_NAME: 'pull_request', PR_BASE_SHA: 'abc123' }],
    ['all-zero PR base', { EVENT_NAME: 'pull_request', PR_BASE_SHA: Z }],
    ['unknown commit', { EVENT_NAME: 'pull_request', PR_BASE_SHA: 'f'.repeat(40) }],
    ['test-only anchor set', { EVENT_NAME: 'pull_request', PR_BASE_SHA: 'a'.repeat(40), MIGRATION_INTEGRITY_ANCHOR: 'a'.repeat(40) }],
  ])('%s -> exit 2', (_name, env) => {
    const r = runCi(REPO_ROOT, env as Record<string, string>);
    expect(r.code, r.out).toBe(2);
  });
});

const shallow = spawnSync('git', ['-c', 'safe.directory=*', 'rev-parse', '--is-shallow-repository'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim() !== 'false';

describe.skipIf(shallow)('migration-integrity-ci.sh end to end on a clone of this repository', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'safe.directory=*', ...a], { cwd, encoding: 'utf8' }).trim();
  const clone = () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-ci-'));
    tmpRoots.push(d);
    git(d, 'clone', '-q', '--no-hardlinks', '--shared', REPO_ROOT, '.');
    // the working-tree versions of the tooling under test (they may not be committed yet)
    for (const f of ['scripts/migration-integrity.cjs', 'scripts/update-migration-checksums.cjs', 'supabase/migrations/checksums.json']) {
      writeFileSync(join(d, f), readFileSync(join(REPO_ROOT, f)));
    }
    return d;
  };
  const head = git(REPO_ROOT, 'rev-parse', 'HEAD');

  it('passes on the current tree against its own HEAD as the PR base', () => {
    const d = clone();
    const r = runCi(d, { EVENT_NAME: 'pull_request', PR_BASE_SHA: head });
    expect(r.out, r.out).toMatch(/^OK$/m);
    expect(r.code, r.out).toBe(0);
  });

  it('fails an edit-and-rehash of a real applied migration (exit 1)', () => {
    const d = clone();
    const mig = readdirSync(join(d, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()[0];
    appendFileSync(join(d, 'supabase', 'migrations', mig), '-- edited\n');
    const mp = join(d, 'supabase', 'migrations', 'checksums.json');
    const m = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, string>;
    m[mig] = createHash('sha256').update(readFileSync(join(d, 'supabase', 'migrations', mig))).digest('hex');
    writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
    const r = runCi(d, { EVENT_NAME: 'pull_request', PR_BASE_SHA: head });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('MODIFIED_MIGRATION');
    expect(r.out).toContain('MANIFEST_ENTRY_CHANGED');
  });

  it('refuses a shallow clone (exit 2)', () => {
    const d = mkdtempSync(join(tmpdir(), 'mig-ci-shallow-'));
    tmpRoots.push(d);
    git(d, 'clone', '-q', '--depth', '1', `file://${REPO_ROOT}`, '.');
    const r = runCi(d, { EVENT_NAME: 'pull_request', PR_BASE_SHA: head });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain('shallow');
  });
});
