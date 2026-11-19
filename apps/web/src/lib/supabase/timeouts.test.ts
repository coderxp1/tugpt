/**
 * Guard (M7): every database lock wait inside create_mcp_snapshot must end well before the app gives up on the
 * PostgREST request, or the app aborts first and the route cannot report the database's answer (Agent 1: the
 * function waited 5 s, the app aborted at 5 s, the route answered 500). Reads the real migrations and server.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSTGREST_REQUEST_TIMEOUT_MS, DB_LOCK_BUDGET_MARGIN_MS } from './timeouts';

const ROOT = join(__dirname, '../../../../..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

function toMs(v: string): number {
  const m = /^(\d+)\s*(ms|s)?$/.exec(v.trim());
  if (!m) throw new Error(`unparseable lock_timeout ${v}`);
  return Number(m[1]) * (m[2] === 'ms' ? 1 : 1000);
}
/** The lock_timeout in force for create_mcp_snapshot: the last migration (in apply order) that sets it. */
function effectiveSnapshotLockTimeoutMs(): { file: string; ms: number } {
  let found: { file: string; ms: number } | null = null;
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const re = /(?:CREATE OR REPLACE FUNCTION|ALTER FUNCTION)\s+public\.create_mcp_snapshot\b[\s\S]*?SET\s+lock_timeout\s*=\s*'([^']+)'/gi;
    for (const m of sql.matchAll(re)) found = { file: f, ms: toMs(m[1]) };
  }
  if (!found) throw new Error('create_mcp_snapshot has no lock_timeout');
  return found;
}

describe('database lock budget vs app request timeout', () => {
  it('the app PostgREST request timeout is 5 s', () => {
    expect(POSTGREST_REQUEST_TIMEOUT_MS).toBe(5000);
  });
  it('create_mcp_snapshot lock_timeout + margin fits inside the app timeout', () => {
    const { file, ms } = effectiveSnapshotLockTimeoutMs();
    expect(file).toBe('20261120000005_mcp_snapshot_lock_timeout_below_app_timeout.sql');
    expect(ms).toBe(2000);
    expect(ms + DB_LOCK_BUDGET_MARGIN_MS).toBeLessThanOrEqual(POSTGREST_REQUEST_TIMEOUT_MS);
  });
  it('server.ts uses the shared constant for both PostgREST clients (no second literal to drift)', () => {
    const src = readFileSync(join(__dirname, 'server.ts'), 'utf8');
    expect(src).not.toMatch(/AbortSignal\.timeout\(\s*\d/);
    expect(src.match(/AbortSignal\.timeout\(POSTGREST_REQUEST_TIMEOUT_MS\)/g)).toHaveLength(2);
  });
});
