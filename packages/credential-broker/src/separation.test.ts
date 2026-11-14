/**
 * Static guard: the credential broker shares nothing with the
 * infrastructure admin MCP bridge (ADR-020 A1.3, threat T-MCP-02).
 *
 * The broker holds the Connect encryption key ring; the admin bridge holds
 * host-level control. Compromise of either must not yield the other. The
 * broker legitimately serves HTTP (node:http) and uses node:crypto/net;
 * it must never spawn processes, evaluate code, or reference the bridge.
 * It has NO runtime dependencies at all, and this test keeps it that way
 * unless the allowlist below is changed in review.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG_DIR = join(__dirname, '..');
const SRC_DIR = join(PKG_DIR, 'src');
const SELF = 'separation.test.ts';

const ALLOWED_DEPENDENCIES: string[] = [];
const ALLOWED_DEV_DEPENDENCIES = ['@types/node', 'typescript', 'vitest'];
const FORBIDDEN_BUILTINS = ['child_process', 'worker_threads', 'cluster', 'vm', 'inspector', 'repl', 'dgram'];
const FORBIDDEN_TEXT = [
  'tugpt-mcp', 'tugpt-admin-broker', 'tugpt-gateway', 'tugpt_mcp_integration',
  'admin_exec', 'docker_exec', 'docker_run', '/opt/tugpt', 'tugpt-exec',
];

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && f !== SELF);
}

function importsOf(text: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  return out;
}

function builtinName(spec: string): string | null {
  const bare = spec.replace(/^node:/, '');
  return builtinModules.includes(bare) || spec.startsWith('node:') ? bare : null;
}

describe('credential-broker is separate from the admin MCP bridge', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;

  it('has exactly the allowlisted dependencies (none at runtime)', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(ALLOWED_DEPENDENCIES);
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([...ALLOWED_DEV_DEPENDENCIES].sort());
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
  });

  it('scans a non-empty source tree', () => {
    expect(sourceFiles()).toEqual(expect.arrayContaining(['service.ts', 'server.ts', 'crypto-v2.ts', 'signing.ts']));
  });

  it.each(sourceFiles())('%s imports no process/eval modules and no third-party packages', (file) => {
    for (const spec of importsOf(readFileSync(join(SRC_DIR, file), 'utf8'))) {
      if (spec.startsWith('.')) continue;
      const builtin = builtinName(spec);
      if (builtin !== null) {
        expect(FORBIDDEN_BUILTINS, `${file} imports ${spec}`).not.toContain(builtin);
        continue;
      }
      const allowed = [...ALLOWED_DEPENDENCIES, ...(file.endsWith('.test.ts') ? ALLOWED_DEV_DEPENDENCIES : [])];
      expect(allowed.some((a) => spec === a || spec.startsWith(`${a}/`)), `${file} imports ${spec}`).toBe(true);
    }
  });

  it.each(sourceFiles())('%s does not name the admin bridge', (file) => {
    const text = readFileSync(join(SRC_DIR, file), 'utf8').toLowerCase();
    for (const needle of FORBIDDEN_TEXT) expect(text.includes(needle), `${file} mentions ${needle}`).toBe(false);
  });

  it('the scanner catches a forbidden import (self-test)', () => {
    expect(importsOf("import { exec } from 'node:child_process';")).toEqual(['node:child_process']);
    expect(builtinName('node:child_process')).toBe('child_process');
  });
});
