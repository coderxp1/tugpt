import { describe, expect, it, vi } from 'vitest';
import { brokerTokenSource, buildChatToolset, conflictingAttachments, dbApprovals, hasRegisteredTool, registeredTools } from './connect';
import type { CapabilityRow, ChatDb } from './store';

const HEX32 = 'ab'.repeat(32);

describe('brokerTokenSource (backend contract: TUGPT_BROKER_URL + hex TUGPT_BROKER_CALLER_KEY)', () => {
  const unavailable = async (env: Record<string, string>) => (await brokerTokenSource(env).getAccessToken({ organizationId: 'o', connectionId: 'c', scopes: [] } as never));

  it('fails closed without configuration', async () => {
    expect(await unavailable({})).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  it('ignores the old variable names', async () => {
    expect(await unavailable({ TUGPT_CREDENTIAL_BROKER_URL: 'http://127.0.0.1:9', TUGPT_CREDENTIAL_BROKER_WEB_KEY: HEX32 })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  it('rejects keys that are not hex or shorter than 32 bytes', async () => {
    const url = 'http://127.0.0.1:9';
    expect(await unavailable({ TUGPT_BROKER_URL: url, TUGPT_BROKER_CALLER_KEY: Buffer.alloc(32).toString('base64') })).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await unavailable({ TUGPT_BROKER_URL: url, TUGPT_BROKER_CALLER_KEY: 'ab'.repeat(31) })).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await unavailable({ TUGPT_BROKER_URL: url, TUGPT_BROKER_CALLER_KEY: 'abc' })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
  it('builds a broker client for a valid hex key', () => {
    const src = brokerTokenSource({ TUGPT_BROKER_URL: 'http://127.0.0.1:9', TUGPT_BROKER_CALLER_KEY: HEX32 });
    expect(src.getAccessToken.toString()).not.toContain('UNAVAILABLE');
  });
});

describe('tool registry', () => {
  it('built-in registry: Google and Outlook calendar availability, read-only; MCP tools come from the per-org registry', () => {
    const tools = registeredTools();
    expect(tools.map((t) => t.provider).sort()).toEqual(['google', 'microsoft']);
    expect(tools.every((t) => t.risk === 'read')).toBe(true);
    const cap = tools[0].capability;
    expect(hasRegisteredTool(cap, 'google')).toBe(true);
    expect(hasRegisteredTool(cap, 'microsoft')).toBe(true);
    expect(hasRegisteredTool('external.search', 'mcp')).toBe(false);
  });
});

const row = (over: Partial<CapabilityRow>): CapabilityRow => ({
  capabilityKey: 'calendar.find_availability', providerKey: 'google', providerName: 'Google', description: 'Find free time',
  permissionClass: 'read', state: 'connected', connectionId: '11111111-1111-4111-8111-111111111111', ...over,
} as CapabilityRow);

describe('conflictingAttachments', () => {
  it('flags Google + Outlook calendar in one message (same model tool name)', () => {
    const cap = registeredTools()[0].capability;
    expect(conflictingAttachments([row({ capabilityKey: cap }), row({ capabilityKey: cap, providerKey: 'microsoft', providerName: 'Microsoft 365' })]))
      .toEqual({ providers: ['Google', 'Microsoft 365'], toolName: 'calendar_find_availability' });
  });
  it('allows a single calendar, duplicates of the same one, and ignores unconnected rows', () => {
    const cap = registeredTools()[0].capability;
    expect(conflictingAttachments([row({ capabilityKey: cap }), row({ capabilityKey: cap })])).toBeNull();
    expect(conflictingAttachments([row({ capabilityKey: cap }), row({ capabilityKey: cap, providerKey: 'microsoft', state: 'requires_connection', connectionId: null })])).toBeNull();
  });
});

describe('dbApprovals (claim_tool_approval)', () => {
  const ctx = { organizationId: 'org-1', userId: 'u-1' };
  const input = { organizationId: 'org-1', actorUserId: 'u-1', connectionId: '11111111-1111-4111-8111-111111111111', capability: 'x.write', argumentsSha256: 'ab' };
  const db = (rpc: ChatDb['rpc']) => ({ from: vi.fn(), rpc: vi.fn(rpc) }) as unknown as ChatDb & { rpc: ReturnType<typeof vi.fn> };

  it('claims through the RPC with the exact arguments and accepts only true', async () => {
    const d = db(async () => ({ data: true, error: null }));
    expect(await dbApprovals(d, ctx).claimApproval(input)).toBe(true);
    expect(d.rpc).toHaveBeenCalledWith('claim_tool_approval', { p_organization_id: 'org-1', p_connection_id: input.connectionId, p_capability: 'x.write', p_arguments_sha256: 'ab' });
  });
  it('fails closed on false, errors, throws, other tenant, other user or a bad id', async () => {
    expect(await dbApprovals(db(async () => ({ data: false, error: null })), ctx).claimApproval(input)).toBe(false);
    expect(await dbApprovals(db(async () => ({ data: true, error: { message: 'x' } } as never)), ctx).claimApproval(input)).toBe(false);
    expect(await dbApprovals(db(async () => { throw new Error('down'); }), ctx).claimApproval(input)).toBe(false);
    const never = db(async () => ({ data: true, error: null }));
    expect(await dbApprovals(never, ctx).claimApproval({ ...input, organizationId: 'org-2' })).toBe(false);
    expect(await dbApprovals(never, ctx).claimApproval({ ...input, actorUserId: 'u-2' })).toBe(false);
    expect(await dbApprovals(never, ctx).claimApproval({ ...input, connectionId: 'not-a-uuid' })).toBe(false);
    expect(never.rpc).not.toHaveBeenCalled();
  });
});

describe('audit is fail-closed (the runtime swallows audit errors, the toolset does not)', () => {
  const CONN = '22222222-2222-4222-8222-222222222222';
  const tool = {
    capability: 'calendar.find_availability', modelName: 'calendar_find_availability', provider: 'google', risk: 'read' as const,
    acceptedScopes: [], description: 'd', parameters: { type: 'object' as const },
    validate: (raw: Record<string, unknown>) => ({ ok: true as const, value: raw }),
    execute: vi.fn(async () => ({ ok: true as const, data: { free: 'private-calendar-data' } })),
  };
  function db(auditError: boolean): ChatDb {
    const accounts = { id: CONN, organization_id: 'org-1', owner_type: 'organization', owner_user_id: null, provider_key: 'google', status: 'connected', scopes: [] };
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: accounts, error: null }) };
    return {
      from: () => q,
      rpc: async (fn: string) => (fn === 'list_chat_capabilities'
        ? { data: [{ capability_key: 'calendar.find_availability', provider_key: 'google', provider_name: 'Google', description: 'd', permission_class: 'read', state: 'connected', connection_id: CONN }], error: null }
        : fn === 'record_connect_tool_call' ? { data: null, error: auditError ? { message: 'down' } : null } : { data: null, error: null }),
    } as unknown as ChatDb;
  }
  const tokens = { getAccessToken: async () => ({ ok: true as const, value: { accessToken: 't', expiresAt: 'x', credentialVersion: 1 } }) };
  const attached = [row({ connectionId: CONN })];
  const ctx = { organizationId: 'org-1', userId: 'u-1', threadId: 't-1' };

  it('returns the result when the audit record is written', async () => {
    const ts = buildChatToolset(db(false), ctx, attached, { tools: [tool as never], tokens });
    const r = await ts.execute({ id: 'c1', name: 'calendar_find_availability', arguments: {} });
    expect(r.ok).toBe(true);
  });
  it('withholds the result and reports INTERNAL when the audit record fails', async () => {
    const ts = buildChatToolset(db(true), ctx, attached, { tools: [tool as never], tokens });
    const r = await ts.execute({ id: 'c2', name: 'calendar_find_availability', arguments: {} });
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(r.content).not.toContain('private-calendar-data');
  });
});
