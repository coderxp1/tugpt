#!/usr/bin/env node
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: runs with plain `node`, no build, no dependencies (CI job and contributors). */
/**
 * Forward-only migration integrity for supabase/migrations.
 *
 *   node scripts/migration-integrity.cjs verify                 # manifest <-> files, offline
 *   node scripts/migration-integrity.cjs verify --base <ref>    # + immutability vs <ref> (CI: the merge base)
 *   node scripts/migration-integrity.cjs verify --history       # + every commit since the anchor
 *   node scripts/migration-integrity.cjs update                 # add entries for NEW migrations only
 *
 * Exit codes: 0 ok, 1 violations found, 2 cannot verify (fail closed: missing git, unknown base,
 * shallow clone, anchor not in history, unreadable manifest). 2 is never a pass.
 *
 * Why three layers. checksums.json lives in the same repository as the files it protects, so on its
 * own it proves only that the two agree: an edit plus a recomputed checksum passes. The immutability
 * check therefore compares against git, not against the manifest:
 *   --base     every migration present at the merge base must still exist, byte-identical, and its
 *              manifest entry must be unchanged; new migrations must sort after the newest base one.
 *   --history  walks every commit from the anchor (the commit that introduced the manifest) to the
 *              base and fails on any deleted/modified/renamed migration or any changed/removed
 *              manifest entry - which catches a base that was itself tampered with (a direct push).
 * The remaining trust is in the anchor SHA and in the reviewers: CODEOWNERS plus branch protection.
 */
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = 'supabase/migrations';
const MANIFEST_NAME = 'checksums.json';
const MANIFEST = `${MIGRATIONS_DIR}/${MANIFEST_NAME}`;
/** b147009: "F-3 migration integrity" introduced checksums.json. Edits before it are pre-policy history. */
const DEFAULT_ANCHOR = 'b1470098ac6da095c7e04742659d5912dc9c2793';
/**
 * MIGRATION_INTEGRITY_ANCHOR exists ONLY so the tool's own tests can run against throwaway repositories.
 * CI must never set it; the guard test apps/worker/tests/migration-integrity-ci.test.ts enforces that.
 */
const ANCHOR = process.env.MIGRATION_INTEGRITY_ANCHOR || DEFAULT_ANCHOR;
const NAME_RE = /^(\d{14})_[a-z0-9_]+\.sql$/;
const HASH_RE = /^[0-9a-f]{64}$/;

class CannotVerify extends Error {}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const canonical = (obj) => `${JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])), null, 2)}\n`;

function git(root, args, opts = {}) {
  try {
    return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
      cwd: root, encoding: opts.encoding === null ? null : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    if (opts.allowFail) return null;
    throw new CannotVerify(`git ${args.join(' ')} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

/** Parse a manifest strictly. Returns { entries, problems }. */
function parseManifest(raw, where) {
  const problems = [];
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new CannotVerify(`${where}: not valid JSON (${e.message})`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new CannotVerify(`${where}: must be a JSON object`);
  // JSON.parse keeps the last of duplicate keys silently; count raw occurrences instead.
  const seen = new Map();
  for (const m of raw.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  for (const [k, n] of seen) if (n > 1) problems.push(['DUPLICATE_KEY', `${where}: "${k}" appears ${n} times`]);
  for (const [k, v] of Object.entries(obj)) {
    if (!NAME_RE.test(k)) problems.push(['BAD_ENTRY_NAME', `${where}: "${k}" is not a migration file name`]);
    if (typeof v !== 'string' || !HASH_RE.test(v)) problems.push(['BAD_HASH', `${where}: "${k}" has no lowercase sha256`]);
  }
  return { entries: obj, problems };
}

function readWorktree(root) {
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!fs.existsSync(dir)) throw new CannotVerify(`${MIGRATIONS_DIR} not found under ${root}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new CannotVerify(`${MANIFEST} not found`);
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const hashes = Object.fromEntries(files.map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))]));
  return { files, hashes, raw };
}

/** Layer 1: the manifest and the directory agree, exactly. */
function checkConsistency(wt) {
  const v = [];
  const { entries, problems } = parseManifest(wt.raw, MANIFEST);
  v.push(...problems);
  if (canonical(entries) !== wt.raw) v.push(['NON_CANONICAL_MANIFEST', `${MANIFEST} is not sorted/canonical; run scripts/update-migration-checksums.cjs`]);
  const versions = new Map();
  for (const f of wt.files) {
    const m = NAME_RE.exec(f);
    if (!m) { v.push(['BAD_FILE_NAME', `${f} does not match <14 digits>_<snake_case>.sql`]); continue; }
    if (versions.has(m[1])) v.push(['DUPLICATE_VERSION', `${f} and ${versions.get(m[1])} share version ${m[1]}`]);
    versions.set(m[1], f);
    if (!(f in entries)) v.push(['MISSING_ENTRY', `${f} has no entry in ${MANIFEST}`]);
    else if (entries[f] !== wt.hashes[f]) v.push(['HASH_MISMATCH', `${f} does not match its manifest entry (edited after it was recorded?)`]);
  }
  for (const k of Object.keys(entries)) if (!wt.files.includes(k)) v.push(['ORPHAN_ENTRY', `${MANIFEST} lists ${k} but the file does not exist (deleted or renamed migration?)`]);
  return { violations: v, entries };
}

function resolveCommit(root, ref) {
  const sha = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (!sha) throw new CannotVerify(`cannot resolve "${ref}" to a commit (shallow clone or missing ref? CI needs fetch-depth: 0)`);
  return sha.trim();
}

function filesAt(root, sha) {
  const out = git(root, ['ls-tree', '-r', '--full-tree', sha, '--', `${MIGRATIONS_DIR}/`]);
  const map = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [meta, p] = line.split('\t');
    const [, type, blob] = meta.split(' ');
    if (type === 'blob') map[p] = blob;
  }
  return map;
}

const blobBytes = (root, blob) => git(root, ['cat-file', 'blob', blob], { encoding: null });

/** Layer 2: nothing that exists at the base changed, and new migrations sort after it. */
function checkAgainstBase(root, wt, entries, baseRef) {
  const v = [];
  const base = resolveCommit(root, baseRef);
  const baseFiles = filesAt(root, base);
  const baseSql = Object.keys(baseFiles).filter((p) => p.endsWith('.sql')).map((p) => path.posix.basename(p)).sort();
  if (baseSql.length === 0) throw new CannotVerify(`base ${base.slice(0, 12)} has no migrations; refusing to treat everything as new`);
  for (const f of baseSql) {
    if (!wt.files.includes(f)) { v.push(['DELETED_MIGRATION', `${f} exists at base ${base.slice(0, 12)} but not here (deleted or renamed)`]); continue; }
    const baseHash = sha256(blobBytes(root, baseFiles[`${MIGRATIONS_DIR}/${f}`]));
    if (baseHash !== wt.hashes[f]) v.push(['MODIFIED_MIGRATION', `${f} differs from base ${base.slice(0, 12)}; applied migrations are immutable - add a new migration instead`]);
  }
  const baseManifestBlob = baseFiles[MANIFEST];
  if (baseManifestBlob) {
    const { entries: baseEntries } = parseManifest(blobBytes(root, baseManifestBlob).toString('utf8'), `${MANIFEST}@base`);
    for (const [k, h] of Object.entries(baseEntries)) {
      if (!(k in entries)) v.push(['MANIFEST_ENTRY_REMOVED', `${k} was removed from ${MANIFEST} (present at base)`]);
      else if (entries[k] !== h) v.push(['MANIFEST_ENTRY_CHANGED', `${k}: manifest checksum changed vs base - the edit-and-rehash bypass`]);
    }
  }
  const newest = baseSql[baseSql.length - 1];
  for (const f of wt.files.filter((x) => !baseSql.includes(x))) {
    if (f.slice(0, 14) <= newest.slice(0, 14)) v.push(['OUT_OF_ORDER', `${f} is new but sorts before/at ${newest} (already at base); databases that applied ${newest} will refuse or skip it - use a later version`]);
  }
  return { violations: v, base };
}

/** Layer 3: every commit from the anchor to `tip` only ever added migrations and manifest entries. */
function checkHistory(root, tip) {
  const v = [];
  if ((git(root, ['rev-parse', '--is-shallow-repository']).trim()) === 'true') throw new CannotVerify('shallow clone; history cannot be verified (CI needs fetch-depth: 0)');
  const anchor = resolveCommit(root, ANCHOR);
  if (git(root, ['merge-base', '--is-ancestor', anchor, tip], { allowFail: true }) === null) {
    // Bootstrap: the one legitimate case is a base from BEFORE the policy existed - the PR that first brings
    // the manifest to a branch. Accept it only when the tip is a strict ancestor of the anchor AND has no
    // manifest; layer 2 still proves every migration on that base is byte-identical. Anything else fails closed.
    const preAnchor = tip !== anchor && git(root, ['merge-base', '--is-ancestor', tip, anchor], { allowFail: true }) !== null;
    if (preAnchor && !(MANIFEST in filesAt(root, tip))) {
      return { violations: v, commits: 0, anchor, bootstrap: true };
    }
    throw new CannotVerify(`anchor ${ANCHOR.slice(0, 12)} is not an ancestor of ${tip.slice(0, 12)} (history rewritten or unrelated branch)`);
  }
  const commits = git(root, ['rev-list', '--parents', `${anchor}..${tip}`]).split('\n').filter(Boolean);
  for (const line of commits) {
    const [c, ...parents] = line.split(' ');
    for (const p of parents) {
      const raw = git(root, ['diff-tree', '-r', '--raw', '--no-abbrev', '--no-renames', p, c, '--', `${MIGRATIONS_DIR}/`]);
      for (const l of raw.split('\n').filter(Boolean)) {
        const [meta, file] = l.split('\t');
        const [, , srcBlob, dstBlob, status] = meta.split(' ');
        const short = `${c.slice(0, 12)} (vs parent ${p.slice(0, 12)})`;
        if (file.endsWith('.sql')) {
          if (status === 'D') v.push(['HISTORY_DELETED_MIGRATION', `${short} deleted ${file}`]);
          else if (status !== 'A' && srcBlob !== dstBlob) v.push(['HISTORY_MODIFIED_MIGRATION', `${short} modified ${file}`]);
        } else if (file === MANIFEST && status !== 'A') {
          if (status === 'D') { v.push(['HISTORY_MANIFEST_DELETED', `${short} deleted ${MANIFEST}`]); continue; }
          const before = parseManifest(blobBytes(root, srcBlob).toString('utf8'), `${MANIFEST}@${p.slice(0, 12)}`).entries;
          const after = parseManifest(blobBytes(root, dstBlob).toString('utf8'), `${MANIFEST}@${c.slice(0, 12)}`).entries;
          for (const [k, h] of Object.entries(before)) {
            if (!(k in after)) v.push(['HISTORY_MANIFEST_ENTRY_REMOVED', `${short} removed ${k} from ${MANIFEST}`]);
            else if (after[k] !== h) v.push(['HISTORY_MANIFEST_ENTRY_CHANGED', `${short} changed the checksum of ${k}`]);
          }
        }
      }
    }
  }
  return { violations: v, commits: commits.length, anchor };
}

function update(root) {
  const wt = readWorktree(root);
  const { entries, problems } = parseManifest(wt.raw, MANIFEST);
  const refuse = [...problems.filter(([c]) => c !== 'DUPLICATE_KEY')];
  for (const f of wt.files) if (!NAME_RE.test(f)) refuse.push(['BAD_FILE_NAME', f]);
  for (const [k, h] of Object.entries(entries)) {
    if (!wt.files.includes(k)) refuse.push(['ORPHAN_ENTRY', `${k} has no file; refusing to drop it (a deleted migration is a violation, not an update)`]);
    else if (wt.hashes[k] !== h) refuse.push(['HASH_MISMATCH', `${k} changed; refusing to re-record it (applied migrations are immutable)`]);
  }
  if (refuse.length) return { code: 1, lines: refuse.map(([c, m]) => `REFUSED ${c}: ${m}`) };
  const added = wt.files.filter((f) => !(f in entries));
  const next = { ...entries };
  for (const f of added) next[f] = wt.hashes[f];
  const out = canonical(next);
  if (out !== wt.raw) fs.writeFileSync(path.join(root, MANIFEST), out);
  return { code: 0, lines: added.length ? added.map((f) => `added ${f} ${wt.hashes[f]}`) : ['no new migrations; manifest unchanged'] };
}

function run(argv, root = process.cwd()) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
  const lines = [];
  try {
    if (cmd === 'update') return update(root);
    if (cmd !== 'verify') return { code: 2, lines: ['usage: migration-integrity.cjs verify [--base <ref>] [--history] | update'] };
    const wt = readWorktree(root);
    const consistency = checkConsistency(wt);
    const all = [...consistency.violations];
    lines.push(`consistency: ${wt.files.length} migrations, ${Object.keys(consistency.entries).length} manifest entries`);
    let tip = null;
    if (rest.includes('--base')) {
      const b = opt('--base');
      if (!b || b.startsWith('--')) throw new CannotVerify('--base needs a ref');
      const r = checkAgainstBase(root, wt, consistency.entries, b);
      all.push(...r.violations); tip = r.base;
      lines.push(`immutability: compared against base ${r.base}`);
    }
    if (rest.includes('--history')) {
      const r = checkHistory(root, tip || resolveCommit(root, 'HEAD'));
      all.push(...r.violations);
      lines.push(r.bootstrap
        ? `history: base ${(tip || 'HEAD').slice(0, 12)} predates the manifest anchor ${r.anchor.slice(0, 12)} (bootstrap: no post-policy history to walk; base comparison still enforced)`
        : `history: ${r.commits} commit(s) from anchor ${r.anchor.slice(0, 12)} to ${(tip || 'HEAD').slice(0, 12)}`);
    }
    for (const [c, m] of all) lines.push(`VIOLATION ${c}: ${m}`);
    lines.push(all.length ? `FAILED: ${all.length} violation(s)` : 'OK');
    return { code: all.length ? 1 : 0, lines };
  } catch (e) {
    if (e instanceof CannotVerify) return { code: 2, lines: [...lines, `CANNOT_VERIFY: ${e.message}`, 'FAILED (not verified)'] };
    return { code: 2, lines: [...lines, `ERROR: ${e && e.stack}`, 'FAILED (not verified)'] };
  }
}

module.exports = { run, ANCHOR, DEFAULT_ANCHOR, MANIFEST, MIGRATIONS_DIR };

if (require.main === module) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) (r.code ? console.error : console.log)(l);
  process.exit(r.code);
}
