/** GET /api/v1/chat/capabilities/models (CONF-1): session required, opaque ids, nothing internal. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { RESTRICTED } from '@/lib/chat/conf1.test-harness';

let signedIn = true;
vi.mock('@/lib/chat/request', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/request')>()),
  chatContext: async () => (signedIn
    ? { db: {}, userId: 'u', tenant: { organizationId: 'o', role: 'member' } }
    : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })),
}));
const { GET } = await import('./route');
const req = () => new Request('https://localhost:3443/api/v1/chat/capabilities/models');

describe('GET /api/v1/chat/capabilities/models', () => {
  afterEach(() => { vi.unstubAllEnvs(); signedIn = true; });

  it('401 without a session', async () => {
    signedIn = false;
    expect((await GET(req())).status).toBe(401);
  });

  it('lists opaque capabilities, private and no-store, with no internal identifiers', async () => {
    vi.stubEnv('TUGPT_PRIVATE_LLM_URL', 'http://127.0.0.1:12435/v1');
    vi.stubEnv('TUGPT_PRIVATE_LLM_MODEL', 'llama4-scout:latest');
    vi.stubEnv('LANGDOCK_API_KEY', 'k-langdock');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const text = await res.text();
    expect(text).not.toMatch(RESTRICTED);
    expect(text).not.toMatch(/langdock|k-langdock|private-gpu/i);
    const body = JSON.parse(text);
    expect(body.contract).toBe('chat-model-capabilities/1');
    expect(body.defaultCapabilityId).toBe('assistant');
    expect(body.capabilities[0]).toEqual({
      id: 'assistant', label: 'TuGPT Assistant', description: expect.any(String), available: true, reasonCode: null, features: { toolCalling: false },
    });
  });

  it('nothing configured: empty list and a null default', async () => {
    vi.stubEnv('TUGPT_PRIVATE_LLM_URL', '');
    vi.stubEnv('LANGDOCK_API_KEY', '');
    expect(await (await GET(req())).json()).toEqual({ contract: 'chat-model-capabilities/1', capabilities: [], defaultCapabilityId: null });
  });
});
