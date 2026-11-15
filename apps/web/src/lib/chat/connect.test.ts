import { describe, expect, it } from 'vitest';
import { brokerTokenSource, hasRegisteredTool, registeredTools } from './connect';

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
  it('registers Google calendar availability and nothing that is not on this branch', () => {
    const tools = registeredTools();
    expect(tools).toHaveLength(1);
    const [t] = tools;
    expect(t.provider).toBe('google');
    expect(hasRegisteredTool(t.capability, t.provider)).toBe(true);
    expect(hasRegisteredTool(t.capability, 'microsoft')).toBe(false);
  });
});
