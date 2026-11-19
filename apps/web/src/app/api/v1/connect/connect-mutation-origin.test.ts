/**
 * Behavioural CSRF/origin regression for every Connect mutation route.
 * Invokes the real route handlers. The session factory is replaced by a spy
 * that records any call, so a rejected request is proven to do no session,
 * database, broker or egress work. (Unit level: no real HTTP here; the real
 * HTTP run is in the Agent 2 M3 evidence, see docs/connect/agent2-handover.md.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.test';
const EP = 'e0000000-0000-4000-8000-00000000000a';
const SNAP = '50000000-0000-4000-8000-00000000000a';
const reached = { session: 0 };

vi.mock('@/lib/supabase/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/server')>()),
  createAuthenticatedServerClient: async () => { reached.session++; throw new Error('SESSION_REACHED'); },
}));

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
const ep = { params: Promise.resolve({ endpointId: EP }) };
const sn = { params: Promise.resolve({ snapshotId: SNAP }) };

const JSON_ROUTES: { name: string; method: string; path: string; load: () => Promise<Handler>; ctx?: unknown }[] = [
  { name: 'register', method: 'POST', path: '/api/v1/connect/mcp/endpoints', load: async () => (await import('./mcp/endpoints/route')).POST as Handler },
  { name: 'delete', method: 'DELETE', path: `/api/v1/connect/mcp/endpoints/${EP}`, load: async () => (await import('./mcp/endpoints/[endpointId]/route')).DELETE as Handler, ctx: ep },
  { name: 'snapshot', method: 'POST', path: `/api/v1/connect/mcp/endpoints/${EP}/snapshot`, load: async () => (await import('./mcp/endpoints/[endpointId]/snapshot/route')).POST as Handler, ctx: ep },
  { name: 'activate', method: 'POST', path: `/api/v1/connect/mcp/endpoints/${EP}/activate`, load: async () => (await import('./mcp/endpoints/[endpointId]/activate/route')).POST as Handler, ctx: ep },
  { name: 'deactivate', method: 'POST', path: `/api/v1/connect/mcp/endpoints/${EP}/deactivate`, load: async () => (await import('./mcp/endpoints/[endpointId]/deactivate/route')).POST as Handler, ctx: ep },
  { name: 'approve snapshot', method: 'POST', path: `/api/v1/connect/mcp/snapshots/${SNAP}/approve`, load: async () => (await import('./mcp/snapshots/[snapshotId]/approve/route')).POST as Handler, ctx: sn },
  { name: 'approval create', method: 'POST', path: '/api/v1/connect/mcp/approvals', load: async () => (await import('./mcp/approvals/route')).POST as Handler },
  { name: 'approval revoke', method: 'POST', path: '/api/v1/connect/mcp/approvals/revoke', load: async () => (await import('./mcp/approvals/revoke/route')).POST as Handler },
  { name: 'google disconnect', method: 'POST', path: '/api/v1/connect/google/disconnect', load: async () => (await import('./google/disconnect/route')).POST as Handler },
  { name: 'microsoft disconnect', method: 'POST', path: '/api/v1/connect/microsoft/disconnect', load: async () => (await import('./microsoft/disconnect/route')).POST as Handler },
];

const GOOD = { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const ATTACKS: { name: string; headers: Record<string, string | undefined> }[] = [
  { name: 'foreign Origin', headers: { ...GOOD, origin: 'https://evil.example' } },
  { name: 'missing Origin', headers: { ...GOOD, origin: undefined } },
  { name: 'Origin "null" (sandboxed iframe)', headers: { ...GOOD, origin: 'null' } },
  { name: 'look-alike Origin', headers: { ...GOOD, origin: 'https://app.test.evil.example' } },
  { name: 'http downgrade Origin', headers: { ...GOOD, origin: 'http://app.test' } },
  { name: 'missing x-tugpt-csrf', headers: { ...GOOD, 'x-tugpt-csrf': undefined } },
  { name: 'text/plain form body', headers: { ...GOOD, 'content-type': 'text/plain' } },
  { name: 'form-urlencoded body', headers: { ...GOOD, 'content-type': 'application/x-www-form-urlencoded' } },
  { name: 'Sec-Fetch-Site cross-site', headers: { ...GOOD, 'sec-fetch-site': 'cross-site' } },
];

function req(method: string, path: string, headers: Record<string, string | undefined>): Request {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h.set(k, v);
  return new Request(`${ORIGIN}${path}`, { method, headers: h, body: method === 'GET' ? undefined : '{}' });
}

beforeEach(() => { reached.session = 0; vi.stubEnv('TUGPT_APP_ORIGIN', ORIGIN); });

describe.each(JSON_ROUTES)('$name ($method)', (route) => {
  it.each(ATTACKS)('rejects $name with 403 and does no work', async ({ headers }) => {
    const handler = await route.load();
    const res = await handler(req(route.method, route.path, headers), route.ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Invalid origin' } });
    expect(reached.session).toBe(0);
  });

  it('lets a same-origin JSON mutation past the guard (authentication still applies)', async () => {
    const handler = await route.load();
    const res = await handler(req(route.method, route.path, GOOD), route.ctx);
    const body = await res.clone().json().catch(() => null) as { error?: { message?: string } } | null;
    expect(body?.error?.message).not.toBe('Invalid origin');
  });

  it('fails closed when TUGPT_APP_ORIGIN is not configured', async () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', '');
    const handler = await route.load();
    const res = await handler(req(route.method, route.path, GOOD), route.ctx);
    expect(res.status).toBe(403);
    expect(reached.session).toBe(0);
  });
});

describe('legacy /api/v1/integrations/google/disconnect (plain HTML form)', () => {
  const load = async () => (await import('../integrations/google/disconnect/route')).POST as Handler;
  const path = '/api/v1/integrations/google/disconnect';
  const form = { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };
  it.each([
    ['foreign Origin', { ...form, origin: 'https://evil.example' }],
    ['missing Origin', { ...form }],
    ['Origin null', { ...form, origin: 'null' }],
    ['cross-site fetch metadata', { ...form, origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
  ])('rejects %s with 403 before any session work', async (_n, headers) => {
    const res = await (await load())(req('POST', path, headers as Record<string, string>));
    expect(res.status).toBe(403);
    expect(reached.session).toBe(0);
  });
  it('accepts a same-origin form post past the guard (no custom header needed)', async () => {
    const res = await (await load())(req('POST', path, { ...form, origin: ORIGIN }));
    const body = await res.clone().json().catch(() => null) as { error?: { message?: string } } | null;
    expect(body?.error?.message).not.toBe('Invalid origin');
  });
});
