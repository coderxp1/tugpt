/**
 * Static guard: the customer-facing Connect runtime has NO path to the
 * infrastructure admin MCP bridge (ADR-020 A1.3, threat T-MCP-02).
 *
 * The admin bridge (tugpt-mcp.service, /opt/tugpt-admin-broker,
 * /opt/tugpt-gateway) lives outside this repository and holds host-level
 * control. Customer tools run model-proposed calls on untrusted input. The
 * two must never share code, credentials, processes or network paths. This
 * test makes the code half of that mechanically checkable:
 *
 *  1. Dependencies are an exact allowlist. Adding one is a reviewed change
 *     to this file, not a silent package.json edit.
 *  2. No source file imports a process-, shell-, filesystem- or raw-socket-
 *     capable Node module. A tool handler that can spawn a process is a
 *     bridge in disguise. (Outbound HTTP goes through `fetch` and, in
 *     staging/production, the allowlisting egress proxy.)
 *  3. No source file names the admin bridge's units, paths or tool names.
 *
 * Network separation (bridge on private interfaces only; egress proxy
 * refusing private ranges) is covered by docs/connect/broker-egress.md and
 * the staging egress smoke evidence, not here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG_DIR = join(__dirname, '..');
const SRC_DIR = join(PKG_DIR, 'src');
const SELF = 'separation.test.ts';

const ALLOWED_DEPENDENCIES = ['@tugpt/ai-providers', '@tugpt/appointments', '@tugpt/credential-broker'];
const ALLOWED_DEV_DEPENDENCIES = ['@types/node', 'typescript', 'vitest'];

const FORBIDDEN_BUILTINS = [
  'child_process', 'worker_threads', 'cluster', 'vm', 'fs', 'fs/promises',
  'net', 'tls', 'dgram', 'http', 'https', 'http2', 'inspector', 'repl',
];

// Never allowed anywhere in the package, tests included.
const PROCESS_BUILTINS = ['child_process', 'worker_threads', 'cluster', 'vm', 'inspector', 'repl'];

// Identifiers of the admin bridge. Matching is case-insensitive.
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

describe('connect-runtime is separate from the admin MCP bridge', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;

  it('depends on exactly the allowlisted packages', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...ALLOWED_DEPENDENCIES].sort());
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([...ALLOWED_DEV_DEPENDENCIES].sort());
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
  });

  it('scans a non-empty source tree (guards against a vacuous pass)', () => {
    expect(sourceFiles()).toEqual(expect.arrayContaining(['runtime.ts', 'google-calendar-tool.ts', 'types.ts']));
  });

  it.each(sourceFiles())('%s imports only allowlisted packages and no process/fs/socket modules', (file) => {
    const imports = importsOf(readFileSync(join(SRC_DIR, file), 'utf8'));
    for (const spec of imports) {
      if (spec.startsWith('.')) continue;
      const builtin = builtinName(spec);
      if (builtin !== null) {
        // Tests may use sockets (e.g. node:net for IP helpers); runtime code may not.
        const forbidden = file.endsWith('.test.ts') ? PROCESS_BUILTINS : FORBIDDEN_BUILTINS;
        expect(forbidden, `${file} imports ${spec}`).not.toContain(builtin);
        continue;
      }
      const allowed = [...ALLOWED_DEPENDENCIES, ...(file.endsWith('.test.ts') ? ALLOWED_DEV_DEPENDENCIES : [])];
      expect(allowed.some((a) => spec === a || spec.startsWith(`${a}/`)), `${file} imports ${spec}`).toBe(true);
    }
  });

  it.each(sourceFiles())('%s does not name the admin bridge', (file) => {
    const text = readFileSync(join(SRC_DIR, file), 'utf8').toLowerCase();
    for (const needle of FORBIDDEN_TEXT) {
      expect(text.includes(needle), `${file} mentions ${needle}`).toBe(false);
    }
  });

  it('the scanner catches forbidden imports (self-test against a vacuous pass)', () => {
    const found = importsOf("import { spawn } from 'node:child_process';\nconst x = require('fs');\nawait import('net');");
    expect(found).toEqual(['node:child_process', 'fs', 'net']);
    expect(found.map(builtinName).every((b) => b !== null && FORBIDDEN_BUILTINS.includes(b))).toBe(true);
  });
});
