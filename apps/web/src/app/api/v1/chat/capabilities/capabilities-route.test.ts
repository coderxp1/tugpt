/**
 * GET /api/v1/chat/capabilities with the production wiring (no injected deps):
 * customer MCP rows are listed but never offered to chat, even when the feature
 * switch and the egress proxy are set, because no MCP audit sink exists yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, fakeDb, type FakeState } from '@/lib/chat/mcp.test-harness';

const ORG = 'a0000000-0000-4000-8000-000000000000';
const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const EP = 'e0000000-0000-4000-8000-00000000000a';
let state: FakeState;

vi.mock('@/lib/chat/request', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/request')>()),
  chatContext: async () => ({ db: fakeDb(state, OWNER), userId: OWNER, tenant: { organizationId: ORG, role: 'owner' } }),
}));

const { GET } = await import('./route');

function seed(): FakeState {
  const s = emptyState();
  s.members = { [ORG]: { [OWNER]: 'owner' } };
  s.endpoints = [{ id: EP, organization_id: ORG, display_name: 'Acme Docs MCP', url: 'https://mcp.test.example/mcp', status: 'active', auth_connection_id: null }];
  s.snapshots = [{ id: 's1', organization_id: ORG, endpoint_id: EP, version: 1, approved_at: '2026-11-15T00:00:00Z', revoked_at: null }];
  s.tools = [{ snapshot_id: 's1', organization_id: ORG, name: 'search_docs', description: 'Search', input_schema: { type: 'object' }, permission_class: 'read' }];
  return s;
}

describe('GET /api/v1/chat/capabilities: customer MCP stays closed in production', () => {
  beforeEach(() => { state = seed(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function mcpRows() {
    const res = await GET(new Request('https://app.test/api/v1/chat/capabilities'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as { capabilities: { providerKey: string; toolAvailable: boolean; capabilityKey: string }[] };
    expect(JSON.stringify(body)).not.toContain('connectionId');
    return body.capabilities.filter((c) => c.providerKey === 'mcp');
  }

  it('switch off: MCP tools are listed as not available', async () => {
    vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', '');
    const rows = await mcpRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.toolAvailable === false)).toBe(true);
  });

  it('switch on and proxy set: still not available, because MCP calls cannot be audited', async () => {
    vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', 'true');
    vi.stubEnv('CONNECT_EGRESS_PROXY', 'http://egress-proxy.test:3128');
    const rows = await mcpRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.toolAvailable === false)).toBe(true);
  });
});
