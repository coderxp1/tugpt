import { describe, expect, it, vi } from 'vitest';
import { disconnectProvider } from './disconnect';
import { customerMcpEnabled } from './flags.server';
import { mcpApi, parseEndpoints, parseTools } from './mcp';
import { oauthBanner } from './contract';
import { toolLabel, toolProblem, turnProblem, requestProblem } from './chat-errors';

const landed = (url: string, ok = true) => ({ ok, status: ok ? 200 : 500, url, json: async () => ({}) }) as unknown as Response;
const fx = (r: Response | Error) => vi.fn(async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;

describe('disconnectProvider (POST /api/v1/connect/{p}/disconnect)', () => {
  it('reads revoked and disconnect_failed from the final redirect URL', async () => {
    expect(await disconnectProvider('google', fx(landed('https://a.example/settings/integrations?google=revoked')))).toBe('revoked');
    expect(await disconnectProvider('microsoft', fx(landed('https://a.example/settings/integrations?microsoft=error&reason=disconnect_failed')))).toBe('failed');
  });
  it('never infers success: other provider, unreadable or network errors are unknown/failed', async () => {
    expect(await disconnectProvider('google', fx(landed('https://a.example/settings/integrations?microsoft=revoked')))).toBe('unknown');
    expect(await disconnectProvider('google', fx(landed('')))).toBe('unknown');
    expect(await disconnectProvider('google', fx(new TypeError('cors')))).toBe('unknown');
    expect(await disconnectProvider('google', fx(landed('https://a.example/x', false)))).toBe('failed');
  });
  it('sends the CSRF header and no body secrets', async () => {
    const f = fx(landed('https://a.example/settings/integrations?google=revoked'));
    await disconnectProvider('google', f);
    expect(f).toHaveBeenCalledWith('/api/v1/connect/google/disconnect', expect.objectContaining({ method: 'POST', body: '{}', headers: expect.objectContaining({ 'x-tugpt-csrf': '1' }) }));
  });
  it('banner wording for the disconnect outcomes', () => {
    expect(oauthBanner({ provider: 'google', outcome: 'error', reason: 'disconnect_failed' }).title).toBe('Google could not be disconnected');
    expect(oauthBanner({ provider: 'google', outcome: 'revoked' }).tone).toBe('ok');
  });
});

describe('customerMcpEnabled', () => {
  it('is off unless explicitly "true"', () => {
    expect(customerMcpEnabled({})).toBe(false);
    expect(customerMcpEnabled({ TUGPT_CUSTOMER_MCP_ENABLED: '1' })).toBe(false);
    expect(customerMcpEnabled({ TUGPT_CUSTOMER_MCP_ENABLED: 'TRUE' })).toBe(false);
    expect(customerMcpEnabled({ TUGPT_CUSTOMER_MCP_ENABLED: 'true' })).toBe(true);
  });
});

describe('MCP contract parsing', () => {
  it('keeps only well-formed endpoints with a known status', () => {
    expect(parseEndpoints({ endpoints: [{ id: 'a', url: 'https://x', displayName: 'X', status: 'active' }, { id: 'b', url: 'https://y', displayName: 'Y', status: 'weird' }, null] }))
      .toEqual([{ id: 'a', url: 'https://x', displayName: 'X', status: 'active', snapshot: null }]);
  });
  it('keeps the stored latest snapshot (survives reload) and drops a malformed one instead of guessing', () => {
    const base = { id: 'a', url: 'https://x', displayName: 'X', status: 'pending', createdAt: '2025-01-02T03:04:05Z' };
    expect(parseEndpoints({ endpoints: [{ ...base, snapshot: { id: 's1', approved: true, toolCount: 3 } }] }))
      .toEqual([{ ...base, snapshot: { id: 's1', approved: true, toolCount: 3 } }]);
    for (const bad of [{ id: '', approved: true, toolCount: 1 }, { id: 's', approved: 'yes', toolCount: 1 }, { id: 's', approved: false, toolCount: -1 }, { id: 's', approved: false, toolCount: 1.5 }, 'x'])
      expect(parseEndpoints({ endpoints: [{ ...base, snapshot: bad }] })![0].snapshot).toBeNull();
    expect(parseEndpoints({})).toBeNull();
  });
  it('keeps only tools with a name and a valid permission class', () => {
    expect(parseTools({ tools: [{ name: 't', description: 1, permissionClass: 'read' }, { name: 'u', permissionClass: 'admin' }, { permissionClass: 'read' }] }))
      .toEqual([{ name: 't', description: '', permissionClass: 'read' }]);
  });
  it('list/tools use GET without cache; malformed bodies become BAD_RESPONSE', async () => {
    const f = vi.fn(async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch;
    expect(await mcpApi.list(f)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    expect(f).toHaveBeenCalledWith('/api/v1/connect/mcp/endpoints', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(await mcpApi.tools('s/1', f)).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    expect(f).toHaveBeenLastCalledWith('/api/v1/connect/mcp/snapshots/s%2F1/tools', expect.anything());
  });
  it('remove uses DELETE with the CSRF header and passes errors through', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '' } }), { status: 404 })) as unknown as typeof fetch;
    expect(await mcpApi.remove('e1', f)).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(f).toHaveBeenCalledWith('/api/v1/connect/mcp/endpoints/e1', expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'x-tugpt-csrf': '1' }) }));
  });
});

describe('chat wording', () => {
  it('covers every runtime tool error code in words', () => {
    for (const code of ['INVALID_ARGUMENTS', 'TOOL_ERROR', 'OUTPUT_TOO_LARGE', 'CALL_BUDGET_EXCEEDED', 'INTERNAL', 'APPROVAL_REQUIRED']) {
      expect(toolProblem(code).text).not.toBe('The app could not complete this step.');
      expect(toolProblem(code).text).not.toContain(code);
    }
    expect(toolProblem('APPROVAL_REQUIRED').text).toMatch(/owner or admin/);
  });
  it('maps turn errors and an interrupted stream', () => {
    expect(turnProblem('MODEL_UNAVAILABLE')).toMatch(/not reachable/);
    expect(turnProblem('MODEL_BAD_RESPONSE')).toMatch(/could not read/);
    expect(turnProblem('STORE_UNAVAILABLE')).toMatch(/saved/);
    expect(turnProblem('INTERRUPTED')).toMatch(/cut off/);
    expect(turnProblem('???')).toBe('The answer could not be completed.');
  });
  it('labels tool steps with the server-provided provider', () => {
    expect(toolLabel('calendar_find_availability', 'Microsoft 365')).toBe('Checking calendar availability in Microsoft 365');
    expect(toolLabel('calendar_find_availability')).toBe('Checking calendar availability');
  });
  it('explains the one-calendar-per-message rule', () => {
    expect(requestProblem('Attach one calendar per message').text).toMatch(/Google and Outlook/);
  });
});
