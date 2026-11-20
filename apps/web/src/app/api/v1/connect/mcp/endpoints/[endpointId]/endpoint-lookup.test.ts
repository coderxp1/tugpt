/**
 * F-M9-1 for the routes that look an endpoint up before acting on it: DELETE endpoint, POST activate,
 * POST deactivate. REAL: the route handlers and the repository's getEndpoint/getEndpointUrl error mapping.
 * MOCKED (labelled): the PostgREST rpc client (stand-in returning PostgREST error shapes), session/tenant
 * (AuthService), the customer MCP flag (on), the egress check, and the mutating repository calls (counted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.test';
const ORG = 'a4000000-0000-4000-8000-00000000000a';
const EP = 'a4000000-0000-4000-8000-0000000e0001';
const st = vi.hoisted(() => ({ error: null as null | { code: string; message: string }, lookups: 0, mutations: 0 }));

vi.mock('@/lib/connect/external-mcp-repo', async (orig) => {
  const real = await orig<typeof import('@/lib/connect/external-mcp-repo')>();
  return {
    ...real,
    createExternalMcpRepository: () => {
      const lookup = real.createExternalMcpRepository({
        rpc: async (_fn: string, a: { p_organization_id: string; p_endpoint_id: string }) => {
          st.lookups++;
          if (st.error) return { data: null, error: st.error };
          return { data: a.p_organization_id === ORG && a.p_endpoint_id === EP ? 'https://mcp.customer.test/mcp' : null, error: null };
        },
      } as never);
      return {
        getEndpoint: (o: string, e: string) => lookup.getEndpoint(o, e),
        hasApprovedSnapshot: async () => true,
        activateEndpoint: async () => { st.mutations++; },
        deactivateEndpoint: async () => { st.mutations++; },
        deleteEndpoint: async () => { st.mutations++; },
      };
    },
  };
});
vi.mock('@/lib/supabase/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/server')>()),
  createAuthenticatedServerClient: async () => ({}),
}));
vi.mock('@tugpt/auth', async (orig) => ({
  ...(await orig<typeof import('@tugpt/auth')>()),
  AuthService: class {
    async getCurrentUser() { return { id: 'u-owner' }; }
    async resolveTenantContext() { return { organizationId: ORG, organizationName: 'Org', role: 'owner' }; }
  },
}));
vi.mock('@/lib/connect-ui/flags.server', () => ({ customerMcpEnabled: () => true }));
vi.mock('@tugpt/connect-runtime', async (orig) => ({
  ...(await orig<typeof import('@tugpt/connect-runtime')>()),
  verifyEgressEnforced: async () => true,
}));

const { DELETE } = await import('./route');
const { POST: ACTIVATE } = await import('./activate/route');
const { POST: DEACTIVATE } = await import('./deactivate/route');

beforeEach(() => { vi.stubEnv('TUGPT_APP_ORIGIN', ORIGIN); Object.assign(st, { error: null, lookups: 0, mutations: 0 }); });
afterEach(() => { vi.unstubAllEnvs(); });

const HEADERS = { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-tenant-id': ORG };
const ROUTES = [
  ['DELETE endpoint', (id: string) => DELETE(new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${id}`, { method: 'DELETE', headers: HEADERS }), { params: Promise.resolve({ endpointId: id }) })],
  ['POST activate', (id: string) => ACTIVATE(new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${id}/activate`, { method: 'POST', body: '{}', headers: HEADERS }), { params: Promise.resolve({ endpointId: id }) })],
  ['POST deactivate', (id: string) => DEACTIVATE(new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${id}/deactivate`, { method: 'POST', body: '{}', headers: HEADERS }), { params: Promise.resolve({ endpointId: id }) })],
] as const;
const code = async (r: Response) => ((await r.json()) as { error?: { code: string } }).error?.code;

describe.each(ROUTES)('%s: endpoint lookup failures (F-M9-1)', (_name, call) => {
  it.each([
    ['our fetch timed out', { code: '', message: 'TimeoutError: The operation was aborted due to timeout' }],
    ['55P03 lock_not_available', { code: '55P03', message: 'canceling statement due to lock timeout' }],
    ['network failure', { code: '', message: 'TypeError: fetch failed' }],
  ])('%s -> 503 DATABASE_TIMEOUT with Retry-After, nothing changed (was 404 NOT_FOUND)', async (_n, error) => {
    st.error = { ...error };
    const r = await call(EP);
    expect(r.status).toBe(503); expect(r.headers.get('retry-after')).toBe('2');
    expect(await code(r)).toBe('DATABASE_TIMEOUT');
    expect([st.lookups, st.mutations]).toEqual([1, 0]);
  });
  it('42501 -> 403 FORBIDDEN, nothing changed', async () => {
    st.error = { code: '42501', message: 'FORBIDDEN' };
    const r = await call(EP);
    expect(r.status).toBe(403); expect(await code(r)).toBe('FORBIDDEN'); expect(st.mutations).toBe(0);
  });
  it('a genuinely missing endpoint is 404 NOT_FOUND; an existing one is acted on', async () => {
    const missing = await call('a4000000-0000-4000-8000-0000000e0fff');
    expect(missing.status).toBe(404); expect(await code(missing)).toBe('NOT_FOUND');
    const ok = await call(EP);
    expect(ok.status).toBe(200); expect(st.mutations).toBe(1);
  });
});
