/**
 * @file migration-integrity-tool.test.ts
 * @description Executes scripts/migration-integrity.cjs as a real child process against throwaway
 * git repositories (real `git`, real files, nothing mocked) and proves each bypass of the
 * forward-only policy is caught:
 *
 *   - a deleted migration (file only -> ORPHAN_ENTRY; file + entry -> DELETED_MIGRATION vs base)
 *   - an orphan manifest entry
 *   - edit-and-rehash (passes the manifest check by construction; caught vs the base, and caught in
 *     history when it was pushed straight onto the base)
 *   - rename, out-of-order versions, duplicate keys, non-canonical manifest
 *   - update refusing to launder an edit or a deletion
 *   - fail-closed exit 2: unknown base, shallow clone, missing / non-ancestor anchor
 *
 * The anchor of the real repository does not exist in a temp repo, so these tests set
 * MIGRATION_INTEGRITY_ANCHOR. That variable is test-only; migration-integrity-ci.test.ts asserts CI
 * never sets it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(process.cwd(), '..', '..');
const TOOL = join(REPO_ROOT, 'scripts', 'migration-integrity.cjs');
const UPDATER = join(REPO_ROOT, 'scripts', 'update-migration-checksums.cjs');
const MIG = join('supabase', 'migrations');
const MANIFEST = join(MIG, 'checksums.json');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'mi-test', GIT_AUTHOR_EMAIL: 'mi-test@example.invalid',
  GIT_COMMITTER_NAME: 'mi-test', GIT_COMMITTER_EMAIL: 'mi-test@example.invalid',
};

const tmpRoots: string[] = [];
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'safe.directory=*', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

interface Result { code: number | null; out: string }
function tool(cwd: string, args: string[], anchor?: string, script = TOOL): Result {
  const env: NodeJS.ProcessEnv = { ...GIT_ENV };
  delete env.MIGRATION_INTEGRITY_ANCHOR;
  if (anchor) env.MIGRATION_INTEGRITY_ANCHOR = anchor;
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const write = (repo: string, rel: string, body: string) => writeFileSync(join(repo, rel), body);
const readManifest = (repo: string) => JSON.parse(readFileSync(join(repo, MANIFEST), 'utf8')) as Record<string, string>;
const writeManifest = (repo: string, m: Record<string, string>) =>
  write(repo, MANIFEST, `${JSON.stringify(Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]])), null, 2)}\n`);
const commitAll = (repo: string, msg: string) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); return git(repo, 'rev-parse', 'HEAD'); };

const M1 = '20260101000001_init.sql';
const M2 = '20260101000002_tables.sql';
const M3 = '20260101000003_policies.sql';
const M4 = '20260102000001_more.sql';

/**
 * pre    : M1 only, no manifest              (a pre-policy base)
 * anchor : M1..M3 + manifest                 (the commit that introduced the manifest)
 * base   : + M4 via the updater              (what a PR would branch from)
 */
function fixture(): { repo: string; pre: string; anchor: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), 'mig-int-'));
  tmpRoots.push(repo);
  git(repo, 'init', '-q');
  mkdirSync(join(repo, MIG), { recursive: true });
  write(repo, join(MIG, M1), 'create schema app;\n');
  const pre = commitAll(repo, 'pre-policy');
  write(repo, join(MIG, M2), 'create table app.t (id int primary key);\n');
  write(repo, join(MIG, M3), 'alter table app.t enable row level security;\n');
  write(repo, MANIFEST, '{}\n');
  expect(tool(repo, ['update']).code).toBe(0);
  const anchor = commitAll(repo, 'anchor: manifest');
  write(repo, join(MIG, M4), 'create index on app.t (id);\n');
  expect(tool(repo, ['update']).code).toBe(0);
  const base = commitAll(repo, 'add M4');
  return { repo, pre, anchor, base };
}

const codes = (out: string) => [...out.matchAll(/VIOLATION ([A-Z_]+)/g)].map((m) => m[1]);

afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }); });

describe('migration-integrity tool: clean states pass', () => {
  it('T0 a correct repository verifies with --base and --history (exit 0)', () => {
    const f = fixture();
    const r = tool(f.repo, ['verify', '--base', f.base, '--history'], f.anchor);
    expect(r.out).toContain('OK');
    expect(r.code).toBe(0);
  });

  it('T1 a legitimate new migration recorded with the documented update script passes', () => {
    const f = fixture();
    write(f.repo, join(MIG, '20260103000001_new.sql'), 'select 1;\n');
    const u = tool(f.repo, [], undefined, UPDATER);
    expect(u.code).toBe(0);
    expect(u.out).toContain('added 20260103000001_new.sql');
    expect(readManifest(f.repo)['20260103000001_new.sql']).toBe(sha256('select 1;\n'));
    commitAll(f.repo, 'pr: new migration');
    expect(tool(f.repo, ['verify', '--base', f.base, '--history'], f.anchor).code).toBe(0);
  });

  it('T2 a PR may correct its OWN unmerged migration before merge', () => {
    const f = fixture();
    const n = '20260103000001_new.sql';
    write(f.repo, join(MIG, n), 'select 1;\n');
    tool(f.repo, ['update']);
    commitAll(f.repo, 'pr: v1');
    write(f.repo, join(MIG, n), 'select 2;\n');
    const m = readManifest(f.repo); delete m[n]; writeManifest(f.repo, m); // documented: drop own entry, re-run update
    expect(tool(f.repo, ['update']).code).toBe(0);
    commitAll(f.repo, 'pr: v2');
    expect(tool(f.repo, ['verify', '--base', f.base, '--history'], f.anchor).code).toBe(0);
  });
});

describe('migration-integrity tool: deletions and orphans', () => {
  it('T3 deleting a migration file but not its entry -> ORPHAN_ENTRY (offline check)', () => {
    const f = fixture();
    unlinkSync(join(f.repo, MIG, M2));
    const r = tool(f.repo, ['verify']);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(['ORPHAN_ENTRY']);
  });

  it('T4 deleting the file AND its entry slips past the manifest, but not past the base', () => {
    const f = fixture();
    unlinkSync(join(f.repo, MIG, M2));
    const m = readManifest(f.repo); delete m[M2]; writeManifest(f.repo, m);
    expect(tool(f.repo, ['verify']).code).toBe(0); // the gap the old test had: consistency alone cannot see it
    const r = tool(f.repo, ['verify', '--base', f.base], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(expect.arrayContaining(['DELETED_MIGRATION', 'MANIFEST_ENTRY_REMOVED']));
  });

  it('T5 a deletion pushed straight onto the base is caught by --history', () => {
    const f = fixture();
    unlinkSync(join(f.repo, MIG, M2));
    const m = readManifest(f.repo); delete m[M2]; writeManifest(f.repo, m);
    const tampered = commitAll(f.repo, 'direct push: drop M2');
    const r = tool(f.repo, ['verify', '--base', tampered, '--history'], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(expect.arrayContaining(['HISTORY_DELETED_MIGRATION', 'HISTORY_MANIFEST_ENTRY_REMOVED']));
  });

  it('T6 an entry for a file that never existed -> ORPHAN_ENTRY', () => {
    const f = fixture();
    const m = readManifest(f.repo); m['20260101000009_ghost.sql'] = sha256('ghost'); writeManifest(f.repo, m);
    const r = tool(f.repo, ['verify']);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(['ORPHAN_ENTRY']);
  });
});

describe('migration-integrity tool: edit-and-rehash', () => {
  it('T7 editing an applied migration and recomputing its checksum is caught vs the base', () => {
    const f = fixture();
    write(f.repo, join(MIG, M2), 'create table app.t (id int primary key, x text);\n');
    const m = readManifest(f.repo); m[M2] = sha256(readFileSync(join(f.repo, MIG, M2), 'utf8')); writeManifest(f.repo, m);
    expect(tool(f.repo, ['verify']).code).toBe(0); // by construction the manifest agrees - this is the bypass
    const r = tool(f.repo, ['verify', '--base', f.base, '--history'], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(expect.arrayContaining(['MODIFIED_MIGRATION', 'MANIFEST_ENTRY_CHANGED']));
  });

  it('T8 the same bypass pushed straight onto the base is caught by --history', () => {
    const f = fixture();
    write(f.repo, join(MIG, M2), 'create table app.t (id bigint primary key);\n');
    const m = readManifest(f.repo); m[M2] = sha256(readFileSync(join(f.repo, MIG, M2), 'utf8')); writeManifest(f.repo, m);
    const tampered = commitAll(f.repo, 'direct push: rehash');
    expect(tool(f.repo, ['verify', '--base', tampered], f.anchor).code).toBe(0); // base comparison alone trusts the base
    const r = tool(f.repo, ['verify', '--base', tampered, '--history'], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(expect.arrayContaining(['HISTORY_MODIFIED_MIGRATION', 'HISTORY_MANIFEST_ENTRY_CHANGED']));
  });

  it('T9 a whitespace-only / line-ending edit is still an edit (raw bytes are hashed)', () => {
    const f = fixture();
    write(f.repo, join(MIG, M3), 'alter table app.t enable row level security;\r\n');
    const m = readManifest(f.repo); m[M3] = sha256(readFileSync(join(f.repo, MIG, M3), 'utf8')); writeManifest(f.repo, m);
    const r = tool(f.repo, ['verify', '--base', f.base], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toContain('MODIFIED_MIGRATION');
  });

  it('T10 update refuses to launder an edit or a deletion and leaves the manifest untouched', () => {
    const f = fixture();
    const before = readFileSync(join(f.repo, MANIFEST), 'utf8');
    write(f.repo, join(MIG, M2), '-- edited\n');
    const r1 = tool(f.repo, [], undefined, UPDATER);
    expect(r1.code).toBe(1);
    expect(r1.out).toContain(`REFUSED HASH_MISMATCH: ${M2}`);
    git(f.repo, 'checkout', '--', join(MIG, M2));
    unlinkSync(join(f.repo, MIG, M3));
    const r2 = tool(f.repo, ['update']);
    expect(r2.code).toBe(1);
    expect(r2.out).toContain(`REFUSED ORPHAN_ENTRY: ${M3}`);
    expect(readFileSync(join(f.repo, MANIFEST), 'utf8')).toBe(before);
  });
});

describe('migration-integrity tool: ordering and shape', () => {
  it('T11 a rename is a deletion of an applied migration', () => {
    const f = fixture();
    git(f.repo, 'mv', join(MIG, M2), join(MIG, '20260101000002_tables_renamed.sql'));
    const m = readManifest(f.repo); m['20260101000002_tables_renamed.sql'] = m[M2]; delete m[M2]; writeManifest(f.repo, m);
    const r = tool(f.repo, ['verify', '--base', f.base], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(expect.arrayContaining(['DELETED_MIGRATION', 'MANIFEST_ENTRY_REMOVED', 'OUT_OF_ORDER']));
  });

  it('T12 a new migration that sorts before the newest applied one -> OUT_OF_ORDER', () => {
    const f = fixture();
    write(f.repo, join(MIG, '20260101500000_late_branch.sql'), 'select 1;\n');
    tool(f.repo, ['update']);
    const r = tool(f.repo, ['verify', '--base', f.base], f.anchor);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toEqual(['OUT_OF_ORDER']);
  });

  it('T13 duplicate manifest keys (JSON.parse would silently keep the last) -> DUPLICATE_KEY', () => {
    const f = fixture();
    const raw = readFileSync(join(f.repo, MANIFEST), 'utf8');
    write(f.repo, MANIFEST, raw.replace(`"${M1}": `, `"${M1}": "${'0'.repeat(64)}",\n  "${M1}": `));
    const r = tool(f.repo, ['verify']);
    expect(r.code).toBe(1);
    expect(codes(r.out)).toContain('DUPLICATE_KEY');
  });

  it('T14 an unsorted manifest -> NON_CANONICAL_MANIFEST; bad names and duplicate versions are rejected', () => {
    const f = fixture();
    const m = readManifest(f.repo);
    write(f.repo, MANIFEST, `${JSON.stringify(Object.fromEntries(Object.entries(m).reverse()), null, 2)}\n`);
    expect(codes(tool(f.repo, ['verify']).out)).toContain('NON_CANONICAL_MANIFEST');
    writeManifest(f.repo, m);
    write(f.repo, join(MIG, 'Bad-Name.sql'), 'select 1;\n');
    write(f.repo, join(MIG, '20260102000001_dup_version.sql'), 'select 1;\n');
    const r = tool(f.repo, ['verify']);
    expect(codes(r.out)).toEqual(expect.arrayContaining(['BAD_FILE_NAME', 'DUPLICATE_VERSION', 'MISSING_ENTRY']));
  });
});

describe('migration-integrity tool: fails closed (exit 2, never a pass)', () => {
  it('T15 an unresolvable base', () => {
    const f = fixture();
    const r = tool(f.repo, ['verify', '--base', 'no-such-ref'], f.anchor);
    expect(r.code).toBe(2);
    expect(r.out).toContain('CANNOT_VERIFY');
  });

  it('T16 a shallow clone cannot verify history', () => {
    const f = fixture();
    const shallow = mkdtempSync(join(tmpdir(), 'mig-int-shallow-'));
    tmpRoots.push(shallow);
    git(shallow, 'clone', '-q', '--depth', '1', `file://${f.repo}`, '.');
    const r = tool(shallow, ['verify', '--history'], f.anchor);
    expect(r.code).toBe(2);
    expect(r.out).toContain('shallow clone');
  });

  it('T17 an anchor that does not exist, or is not an ancestor', () => {
    const f = fixture();
    expect(tool(f.repo, ['verify', '--history'], 'f'.repeat(40)).code).toBe(2);
    git(f.repo, 'checkout', '-q', '--orphan', 'rewritten');
    commitAll(f.repo, 'rewritten history with the same files');
    const r = tool(f.repo, ['verify', '--history'], f.anchor);
    expect(r.code).toBe(2);
    expect(r.out).toContain('not an ancestor');
  });

  it('T18 a base with no migrations is refused rather than treating everything as new', () => {
    const f = fixture();
    git(f.repo, 'checkout', '-q', '--orphan', 'empty');
    git(f.repo, 'rm', '-rq', '--cached', '.');
    write(f.repo, 'README', 'x\n');
    git(f.repo, 'add', 'README');
    git(f.repo, 'commit', '-q', '-m', 'empty');
    const empty = git(f.repo, 'rev-parse', 'HEAD');
    git(f.repo, 'checkout', '-q', '-f', 'main');
    const r = tool(f.repo, ['verify', '--base', empty], f.anchor);
    expect(r.code).toBe(2);
  });
});

describe('migration-integrity tool: bootstrap (first PR that brings the manifest to a branch)', () => {
  it('T19 a pre-policy base without a manifest is accepted; its migrations are still byte-compared', () => {
    const f = fixture();
    const ok = tool(f.repo, ['verify', '--base', f.pre, '--history'], f.anchor);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('bootstrap');
    write(f.repo, join(MIG, M1), 'create schema app2;\n');
    const m = readManifest(f.repo); m[M1] = sha256('create schema app2;\n'); writeManifest(f.repo, m);
    const bad = tool(f.repo, ['verify', '--base', f.pre, '--history'], f.anchor);
    expect(bad.code).toBe(1);
    expect(codes(bad.out)).toContain('MODIFIED_MIGRATION');
  });
});
