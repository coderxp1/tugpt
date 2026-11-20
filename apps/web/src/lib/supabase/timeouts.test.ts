/**
 * Guard (M7): every database lock wait inside create_mcp_snapshot must end well before the app gives up on the
 * PostgREST request, or the app aborts first and the route cannot report the database's answer (Agent 1: the
 * function waited 5 s, the app aborted at 5 s, the route answered 500). Reads the real migrations and server.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSupabaseClient } from '@tugpt/database';
import {
  POSTGREST_REQUEST_TIMEOUT_MS, DB_LOCK_BUDGET_MARGIN_MS, SNAPSHOT_WRITE_DEADLINE_MS, asNonRetryableTimeout,
} from './timeouts';
import { isTransportTimeout } from '@/lib/connect/external-mcp-repo';

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
  it('server.ts wraps both PostgREST fetches in asNonRetryableTimeout (M9: no 3x GET retry after a timeout)', () => {
    const src = readFileSync(join(__dirname, 'server.ts'), 'utf8');
    expect(src.match(/asNonRetryableTimeout\(signal, fetch\(outgoing/g)).toHaveLength(2);
  });
});

describe('snapshot write deadline (M9, migration 20261120000006)', () => {
  const sql = readFileSync(join(MIGRATIONS, '20261120000006_mcp_snapshot_idempotency.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('CREATE FUNCTION public.create_mcp_snapshot_idempotent'), sql.indexOf('ALTER FUNCTION public.create_mcp_snapshot_idempotent'));
  it('the app deadline is the request timeout minus the margin (3 s)', () => {
    expect(SNAPSHOT_WRITE_DEADLINE_MS).toBe(3000);
    expect(SNAPSHOT_WRITE_DEADLINE_MS + DB_LOCK_BUDGET_MARGIN_MS).toBeLessThanOrEqual(POSTGREST_REQUEST_TIMEOUT_MS);
  });
  it('the database caps the deadline at the same 3 s and its lock_timeout fits inside it', () => {
    expect(fn).toMatch(/LEAST\(COALESCE\(p_deadline, statement_timestamp\(\) \+ interval '3 seconds'\),\s*statement_timestamp\(\) \+ interval '3 seconds'\)/);
    const lt = /SET lock_timeout = '(\d+)s'/.exec(fn);
    expect(lt).not.toBeNull();
    expect(Number(lt![1]) * 1000).toBeLessThanOrEqual(SNAPSHOT_WRITE_DEADLINE_MS);
  });
  it('the deadline is checked as the last step before RETURN, raising the non-retryable PT504', () => {
    const lastCheck = fn.lastIndexOf('clock_timestamp() > v_deadline');
    expect(lastCheck).toBeGreaterThan(fn.lastIndexOf('INSERT INTO public.external_tool_snapshot_requests'));
    expect(fn.slice(lastCheck)).toMatch(/ERRCODE = 'PT504'[\s\S]*RETURN jsonb_build_object/);
  });
});

/**
 * REAL postgrest-js (via @tugpt/database) against a REAL local HTTP server that accepts requests and never
 * answers. Short timeouts stand in for the 5 s production value; the retry policy is the library's own.
 */
describe('a timed-out GET is reported once, never retried (M9: Agent 1 saw reads of ~7.6 s)', () => {
  let server: http.Server; let base = ''; let hits = 0;
  beforeAll(async () => {
    server = http.createServer(() => { hits++; /* never respond */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const client = (wrap: boolean) => createSupabaseClient(base, 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = AbortSignal.timeout(200);
      const p = fetch(input, { ...init, signal });
      return wrap ? asNonRetryableTimeout(signal, p) : p;
    } },
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('characterisation (the bug): a raw AbortSignal.timeout GET is retried by postgrest-js', async () => {
    hits = 0;
    const t0 = Date.now();
    const { error } = await (client(false) as unknown as { from(t: string): { select(c: string): Promise<{ error: unknown }> } }).from('t').select('x');
    expect(hits).toBeGreaterThanOrEqual(2); // retried after the 1 s back-off
    expect(Date.now() - t0).toBeGreaterThan(1000);
    expect(error).toBeTruthy();
  }, 20000);
  it('with asNonRetryableTimeout: one request, error within the timeout, recognised as a transport timeout', async () => {
    hits = 0;
    const t0 = Date.now();
    const { error } = await (client(true) as unknown as { from(t: string): { select(c: string): Promise<{ error: unknown }> } }).from('t').select('x');
    const elapsed = Date.now() - t0;
    await sleep(1500); // a retry would arrive after the 1 s back-off
    expect(hits).toBe(1);
    expect(elapsed).toBeLessThan(900);
    expect(isTransportTimeout(error)).toBe(true);
    expect((error as { message: string }).message).toMatch(/^AbortError: TimeoutError: database request exceeded/);
  }, 20000);
  it('a non-timeout fetch failure is rethrown unchanged', async () => {
    const boom = new TypeError('fetch failed');
    await expect(asNonRetryableTimeout(new AbortController().signal, Promise.reject(boom))).rejects.toBe(boom);
  });
});
