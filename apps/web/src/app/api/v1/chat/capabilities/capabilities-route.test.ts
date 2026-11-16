/**
 * GET /api/v1/chat/capabilities with the production wiring (no injected deps):
 * customer MCP rows are listed but only offered to chat when the Connect switch,
 * the separate chat execution switch and the egress proxy are all set (the
 * audit sink is Agent 2's record_mcp_tool_call, wired by default). Each closed
 * gate is reported as a stable unavailableReason code for the picker.
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
vi.mock('@/lib/supabase/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/server')>()),
  createSsoControlClient: async () => fakeDb(state, OWNER),
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
    const body = (await res.json()) as { capabilities: { providerKey: string; toolAvailable: boolean; capabilityKey: string; unavailableReason?: string }[] };
    expect(JSON.stringify(body)).not.toContain('connectionId');
    return body.capabilities.filter((c) => c.providerKey === 'mcp');
  }

  it('switch off: MCP tools are listed as not available', async () => {
    vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', '');
    const rows = await mcpRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.toolAvailable === false && r.unavailableReason === 'MCP_FEATURE_OFF')).toBe(true);
  });

  it('Connect switch on and proxy set: still not available, because chat execution is a separate switch', async () => {
    vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', 'true');
    vi.stubEnv('TUGPT_CHAT_MCP_EXECUTION_ENABLED', '');
    vi.stubEnv('CONNECT_EGRESS_PROXY', 'http://egress-proxy.test:3128');
    const rows = await mcpRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.toolAvailable === false && r.unavailableReason === 'MCP_CHAT_EXECUTION_OFF')).toBe(true);
  });

  it('both switches on but no proxy: not available (no network path)', async () => {
    vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', 'true');
    vi.stubEnv('TUGPT_CHAT_MCP_EXECUTION_ENABLED', 'true');
    vi.stubEnv('CONNECT_EGRESS_PROXY', '');
    const rows = await mcpRows();
    expect(rows.every((r) => r.toolAvailable === false && r.unavailableReason === 'MCP_EGRESS_NOT_CONFIGURED')).toBe(true);
  });

  it('all gates open (switches, proxy, default audit sink): the runnable tool is offered, without a reason', async () => {
    vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', 'true');
    vi.stubEnv('TUGPT_CHAT_MCP_EXECUTION_ENABLED', 'true');
    vi.stubEnv('CONNECT_EGRESS_PROXY', 'http://egress-proxy.test:3128');
    const rows = await mcpRows();
    expect(rows).toEqual([expect.objectContaining({ capabilityKey: 'external.search_docs', toolAvailable: true })]);
    expect(rows[0].unavailableReason).toBeUndefined();
  });
});
