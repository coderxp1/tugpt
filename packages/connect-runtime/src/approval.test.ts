import { describe, it, expect } from 'vitest';
import { ConnectToolRuntime, type ConnectToolRuntimeOptions } from './runtime.js';
import type { ConnectTool, ToolExecutionContext } from './types.js';

const writeTool = {
  capability: 'external.write',
  modelName: 'external_write',
  provider: 'mcp',
  risk: 'write',
  acceptedScopes: [],
  description: 'write tool',
  parameters: { type: 'object', properties: { x: { type: 'string' } } },
  validate: (raw: Readonly<Record<string, unknown>>) => ({ ok: true, value: raw }),
  execute: async () => ({ ok: true, data: { done: true } }),
} as unknown as ConnectTool<never>;

const ctx: ToolExecutionContext = {
  organizationId: 'org1',
  actorUserId: 'user1',
  agentId: null,
  connectionId: 'conn1',
  requestId: 'req1',
};

function build(claim: () => Promise<boolean> | undefined) {
  const opts = {
    tools: [writeTool],
    connections: {
      getConnection: async () => ({
        id: 'conn1', organizationId: 'org1', ownerUserId: null,
        provider: 'mcp', status: 'connected', grantedScopes: [] as string[],
      }),
    },
    policy: { isCapabilityEnabled: async () => true },
    grants: { isGranted: async () => true },
    tokens: { getAccessToken: async () => ({ ok: true, value: { accessToken: 'tok', expiresAt: 'x' } }) },
    audit: { record: async () => {} },
    approvals: claim === undefined ? undefined : { claimApproval: claim },
  } as unknown as ConnectToolRuntimeOptions;
  return new ConnectToolRuntime(opts);
}

describe('ConnectToolRuntime approval (B-7)', () => {
  it('blocks a write tool when the approval is not claimed (fail closed)', async () => {
    const rt = build(async () => false);
    const [r] = await rt.executeTurn(ctx, [{ id: 'c1', name: 'external_write', arguments: { x: 'y' } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('APPROVAL_REQUIRED');
  });

  it('executes a write tool after an atomic claim', async () => {
    const rt = build(async () => true);
    const [r] = await rt.executeTurn(ctx, [{ id: 'c1', name: 'external_write', arguments: { x: 'y' } }]);
    expect(r.ok).toBe(true);
  });

  it('blocks a write tool when no approval checker is wired (fail closed)', async () => {
    const rt = build(undefined);
    const [r] = await rt.executeTurn(ctx, [{ id: 'c1', name: 'external_write', arguments: { x: 'y' } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('APPROVAL_REQUIRED');
  });
});
