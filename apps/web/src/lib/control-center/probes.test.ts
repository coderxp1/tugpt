// Supabase reachability probe. Every branch the health endpoint can report
// is driven here with an injected fetch, so the UI's "reachable / configured
// but unreachable / not configured" wording is pinned to real outcomes.

import { describe, expect, it, vi } from 'vitest';
import { probeDatabase } from './probes';

const URL_ = 'https://abc.supabase.co';
const KEY = 'anon-key';

describe('probeDatabase', () => {
  it('reports not configured without touching the network', async () => {
    const fetchImpl = vi.fn();
    const r = await probeDatabase({ url: '', anonKey: '', fetchImpl });
    expect(r).toMatchObject({ configured: false, reachable: null, available: false, host: null, latencyMs: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls /auth/v1/health on the origin with the anon key and reports reachable on 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"name":"GoTrue"}', { status: 200 }));
    const r = await probeDatabase({ url: `${URL_}/some/path?x=1`, anonKey: KEY, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(`${URL_}/auth/v1/health`);
    expect((init.headers as Record<string, string>).apikey).toBe(KEY);
    expect(r).toMatchObject({ configured: true, reachable: true, available: true, host: URL_ });
    expect(typeof r.latencyMs).toBe('number');
    // The reason names the host, never the key.
    expect(r.reason).toContain(URL_);
    expect(r.reason).not.toContain(KEY);
  });

  it('reports configured-but-unreachable on a non-2xx answer', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const r = await probeDatabase({ url: URL_, anonKey: KEY, fetchImpl });
    expect(r).toMatchObject({ configured: true, reachable: false, available: false, host: URL_ });
    expect(r.reason).toContain('503');
  });

  it('reports configured-but-unreachable when fetch throws or times out', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn(async () => {
      throw err;
    });
    const r = await probeDatabase({ url: URL_, anonKey: KEY, fetchImpl, timeoutMs: 50 });
    expect(r).toMatchObject({ configured: true, reachable: false, available: false, host: URL_ });
    expect(r.reason).toContain('TimeoutError');
    expect(r.reason).toContain('50 ms');
  });

  it('rejects an unparseable URL without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const r = await probeDatabase({ url: 'not a url', anonKey: KEY, fetchImpl });
    expect(r).toMatchObject({ configured: true, reachable: false, available: false, host: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
