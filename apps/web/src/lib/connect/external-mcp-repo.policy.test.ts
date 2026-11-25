/**
 * The per-org policy lever repo methods (Plan A3): read defaults to OFF when
 * no policy row exists (fail closed); write goes through the owner/admin RPC.
 * Clients are labelled stand-ins, following external-mcp-repo.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createExternalMcpRepository } from './external-mcp-repo';

const ORG = '00000000-0000-4000-8000-000000000001';

function rpcClient(result: { data?: unknown; error?: { code: string; message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: result.data ?? null, error: result.error ?? null };
      },
    },
  };
}

function readClient(data: unknown, error: { code: string; message?: string } | null = null) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data, error });
  return { from: () => chain };
}

describe('getExternalToolsPolicy', () => {
  it('returns the stored value', async () => {
    const repo = createExternalMcpRepository(readClient({ allow_external_tools: true }) as never);
    await expect(repo.getExternalToolsPolicy(ORG)).resolves.toBe(true);
  });

  it('defaults to false when the org has no policy row', async () => {
    const repo = createExternalMcpRepository(readClient(null) as never);
    await expect(repo.getExternalToolsPolicy(ORG)).resolves.toBe(false);
  });
});

describe('setExternalToolsPolicy', () => {
  it('calls the RPC and returns the resulting state', async () => {
    const { client, calls } = rpcClient({ data: true });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.setExternalToolsPolicy(ORG, true)).resolves.toBe(true);
    expect(calls).toEqual([
      { fn: 'set_external_tools_policy', args: { p_organization_id: ORG, p_enabled: true } },
    ]);
  });

  it('disabling returns false (the RPC echoes the value it set)', async () => {
    const { client } = rpcClient({ data: false });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.setExternalToolsPolicy(ORG, false)).resolves.toBe(false);
  });
});
