import { describe, expect, it, vi } from 'vitest';
import { AGENT_LIMITS, cleanAgent, createAgentsClient, validateAgent, type AgentInput } from './custom-agents';

const base: AgentInput = { name: 'Shipping helper', description: null, instructions: 'Answer shipping questions.', modelKey: null, starters: [], collectionIds: [], visibility: 'private' };

describe('custom agents (contract C-1)', () => {
  it('validates name, instructions and starters like the server', () => {
    expect(validateAgent(base)).toBeNull();
    expect(validateAgent({ ...base, name: '  ' })).toBe('name');
    expect(validateAgent({ ...base, name: 'x'.repeat(AGENT_LIMITS.name + 1) })).toBe('name');
    expect(validateAgent({ ...base, instructions: '' })).toBe('instructions');
    expect(validateAgent({ ...base, starters: ['a', 'b', 'c', 'd', 'e'] })).toBe('starters');
  });
  it('sends trimmed values and drops empty starters', () => {
    expect(cleanAgent({ ...base, name: ' A ', description: '  ', starters: [' hi ', '', '  '], collectionIds: ['c1', 'c1'] }))
      .toEqual({ ...base, name: 'A', description: null, starters: ['hi'], collectionIds: ['c1'] });
  });
  it('mutations carry the CSRF header; a route that is not deployed is reported as UNEXPECTED_RESPONSE', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ agent: { id: 'a1' } }), { status: 201 })
      : new Response('<!DOCTYPE html>', { status: 404, headers: { 'content-type': 'text/html' } })));
    const api = createAgentsClient(fetchFn);
    expect(await api.listAgents()).toEqual({ ok: false, status: 404, error: 'UNEXPECTED_RESPONSE' });
    const r = await api.createAgent(base);
    expect(r.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[1];
    expect((init?.headers as Record<string, string>)['x-tugpt-csrf']).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual(base);
  });
});

const responseFields = {
  id: 'a1', ownedByMe: true, canEdit: true, canDelete: true, version: 7,
  createdAt: '2026-01-01', updatedAt: '2026-02-01', tools: [{ capability: 'write', provider: 'test' }],
  organizationId: 'foreign-org', ownerUserId: 'other-user', unexpected: 'do not send',
};

describe('agent request field whitelist', () => {
  it('cleans an edit-form copy without carrying resource, permission or tool fields', () => {
    expect(cleanAgent({ ...base, ...responseFields })).toEqual(base);
  });

  it('whitelists both POST and PATCH at the HTTP boundary even for uncleaned resources', async () => {
    const calls: { method: string; body: unknown; headers: HeadersInit | undefined; credentials: RequestCredentials | undefined }[] = [];
    const api = createAgentsClient(async (_url, init) => {
      calls.push({ method: init!.method!, body: JSON.parse(String(init?.body)), headers: init?.headers, credentials: init?.credentials });
      return new Response(JSON.stringify({ agent: { ...base, id: 'a1' } }), { status: 200 });
    });
    await api.createAgent({ ...base, ...responseFields });
    await api.updateAgent('a1', { ...base, ...responseFields });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    for (const call of calls) {
      expect(call.body).toEqual(base);
      expect(call.credentials).toBe('same-origin');
      expect(new Headers(call.headers).get('x-tugpt-csrf')).toBe('1');
    }
  });

  it('preserves partial PATCH omission, explicit nulls and empty arrays', async () => {
    const sent: unknown[] = [];
    const api = createAgentsClient(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ agent: { id: 'a1' } }), { status: 200 });
    });
    await api.updateAgent('a1', { name: 'Renamed', instructions: undefined, ...responseFields });
    await api.updateAgent('a1', { description: null, modelKey: null, starters: [], collectionIds: [], ...responseFields });
    expect(sent).toEqual([{ name: 'Renamed' }, { description: null, modelKey: null, starters: [], collectionIds: [] }]);
  });
});
it('honors Retry-After seconds without replaying a write', async () => {
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:'RATE_LIMITED'}),{status:429,headers:{'retry-after':'120'}}));const api=createAgentsClient(fetcher);
 const r=await api.createAgent(base);expect(r.ok).toBe(false);expect(api.retryAt()).toBeGreaterThan(Date.now()+119000);
 await api.createAgent(base);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('honors Retry-After HTTP dates', async () => {
 const date=new Date(Date.now()+120000).toUTCString();const api=createAgentsClient(async()=>new Response('{}',{status:429,headers:{'retry-after':date}}));await api.createAgent(base);expect(api.retryAt()).toBe(Date.parse(date));
});
