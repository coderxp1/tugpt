/**
 * Platform resolver + capability shaping (B5/B6) against labelled fakes:
 * a stub platform repository, a stub broker port, and a fake egress fetch
 * speaking the MCP session protocol. Proves the per-call re-checks, the
 * token path, and the D4 leak boundary (no provider identity in the shaped
 * capability).
 */
import { describe, expect, it } from 'vitest';
import { createPlatformCaller, resolvePlatformEndpoint, PlatformResolveError } from './platform-resolver';
import { listEntitledCapabilities, PLATFORM_CAPABILITY_DEFINITIONS } from './capabilities';
import type { PlatformRepository } from './platform-repo';

const EP = 'e0000000-0000-4000-8000-000000000001';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-0000000000aa';

function repo(opts: { status?: string; connStatus?: string; approved?: boolean } = {}): PlatformRepository {
  const endpoint = {
    id: EP, kind: 'mcp', url: 'https://mcp.heygen.test/mcp/v1/', displayName: 'HeyGen',
    status: opts.status ?? 'active', createdAt: '2026-11-25T00:00:00Z',
    connection: { id: CONN, providerKey: 'heygen', credentialKind: 'oauth_token_set', status: opts.connStatus ?? 'connected' },
    latestSnapshot: null,
  };
  return {
    getEndpoint: async () => endpoint,
    getApprovedTools: async () => (opts.approved === false ? null : {
      snapshotId: 'snap-1',
      tools: [{ name: 'generate_video', description: 'remote desc', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }, permissionClass: 'financial' as const }],
    }),
    getBinding: async () => ({ capabilityKey: 'video.generate', endpointId: EP, toolName: 'generate_video', config: {}, enabled: true }),
  } as unknown as PlatformRepository;
}

const brokerOk = {
  getPlatformAccessToken: async () => ({ ok: true as const, value: { accessToken: 'HG-TOKEN', expiresAt: '2099-01-01T00:00:00.000Z', credentialVersion: 1 } }),
};
const brokerDown = {
  getPlatformAccessToken: async () => ({ ok: false as const, code: 'NOT_CONNECTED' }),
};

/** Fake egress fetch: answers the MCP session handshake + tools/call. */
function mcpFetch(calls: { auth: string | null }[]) {
  return async (_url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const msg = JSON.parse(init.body) as { method?: string; id?: number };
    calls.push({ auth: init.headers.authorization ?? init.headers.Authorization ?? null });
    const respond = (status: number, payload: unknown, session = false) => ({
      status,
      headers: { get: (n: string) => (session && n.toLowerCase() === 'mcp-session-id' ? 'sess-1' : null) },
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });
    if (msg.method === 'initialize') {
      return respond(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }, true);
    }
    if (msg.method === 'notifications/initialized') return respond(202, '');
    if (msg.method === 'tools/call') {
      return respond(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ video_id: 'vid-1', status: 'processing' }) }] } });
    }
    return respond(400, { error: 'unknown' });
  };
}

describe('platform resolver (B5)', () => {
  it('resolves an active endpoint with an approved snapshot and a connected connection', async () => {
    const resolved = await resolvePlatformEndpoint(repo(), EP);
    expect(resolved).toMatchObject({ endpointId: EP, connectionId: CONN, snapshotId: 'snap-1' });
    expect(resolved.tools.map((t) => t.name)).toEqual(['generate_video']);
  });

  it.each([
    [{ status: 'disabled' }, 'ENDPOINT_NOT_ACTIVE'],
    [{ connStatus: 'requires_authorization' }, 'NOT_CONNECTED'],
    [{ approved: false }, 'SNAPSHOT_NOT_APPROVED'],
  ] as const)('fails closed: %o -> %s', async (opts, code) => {
    await expect(resolvePlatformEndpoint(repo(opts), EP)).rejects.toMatchObject({ code });
  });

  it('executes through the runtime with the broker token on the wire', async () => {
    const calls: { auth: string | null }[] = [];
    const caller = createPlatformCaller({ repo: repo(), broker: brokerOk, egressFetch: mcpFetch(calls) as never, resolveHostname: async () => ['93.184.216.34'] });
    const out = await caller.callTool(EP, 'generate_video', { prompt: 'a cat in a hat' });
    expect(out.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.auth === 'Bearer HG-TOKEN')).toBe(true);
    expect(JSON.stringify(out)).toContain('vid-1');
    expect(JSON.stringify(out)).not.toContain('HG-TOKEN');
  });

  it('refuses tools outside the approved snapshot and broker failures, before any fetch', async () => {
    const calls: { auth: string | null }[] = [];
    const caller = createPlatformCaller({ repo: repo(), broker: brokerOk, egressFetch: mcpFetch(calls) as never });
    await expect(caller.callTool(EP, 'delete_everything', {})).rejects.toMatchObject({ code: 'TOOL_NOT_APPROVED' });
    const down = createPlatformCaller({ repo: repo(), broker: brokerDown, egressFetch: mcpFetch(calls) as never });
    await expect(down.callTool(EP, 'generate_video', { prompt: 'x' })).rejects.toMatchObject({ code: 'TOKEN_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });
});

describe('capability shaping (B6)', () => {
  const adminWithFlag = (on: boolean) => ({
    rpc: async () => ({ data: on, error: null }),
  }) as never;

  it('an entitled org with an enabled binding gets the TuGPT-shaped capability only', async () => {
    const caps = await listEntitledCapabilities(adminWithFlag(true), repo(), ORG);
    expect(caps).toHaveLength(1);
    const cap = caps[0];
    expect(cap.toolName).toBe('generate_video');
    expect(cap.description).toBe(PLATFORM_CAPABILITY_DEFINITIONS[0].description);
    // D4 leak boundary: the org-facing shape contains no provider identity,
    // no endpoint URL and no binding internals.
    const shaped = JSON.stringify({ toolName: cap.toolName, displayName: cap.displayName, description: cap.description, parameters: cap.parameters });
    expect(shaped).not.toMatch(/heygen/i);
    expect(shaped).not.toContain('mcp.heygen.test');
  });

  it('no entitlement flag -> no capability, even with a binding', async () => {
    await expect(listEntitledCapabilities(adminWithFlag(false), repo(), ORG)).resolves.toEqual([]);
  });
});
