import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationOrigin, isSameOriginMutation, readSmallJson, readJsonRecord } from './mutations';

function request(origin = 'https://workspace.example', extra: Record<string, string> = {}) {
  return new Request('http://internal-web:3000/api/v1/workspace', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-tugpt-csrf': '1', ...extra },
  });
}
afterEach(() => vi.unstubAllEnvs());
describe('configured browser origin', () => {
  it('accepts the configured public origin despite an internal reconstructed URL', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://workspace.example');
    expect(isSameOriginMutation(request())).toBe(true);
  });
  it('does not also accept the internal reconstructed origin', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://workspace.example');
    expect(isSameOriginMutation(request('http://internal-web:3000'))).toBe(false);
  });
  it('ignores forged forwarding headers', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://workspace.example');
    const r = request('https://attacker.example', { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' });
    expect(applicationOrigin(r)).toBe('https://workspace.example');
    expect(isSameOriginMutation(r)).toBe(false);
  });
  it('fails closed without configuration instead of trusting the request URL', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', '');
    expect(() => applicationOrigin(request())).toThrow();
    expect(isSameOriginMutation(request('http://internal-web:3000'))).toBe(false);
  });
  it('fails closed for malformed configured origins', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'not a URL');
    expect(isSameOriginMutation(request())).toBe(false);
  });
  it('still requires the non-simple CSRF header', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://workspace.example');
    expect(isSameOriginMutation(request(undefined, { 'x-tugpt-csrf': '' }))).toBe(false);
  });
  it('still rejects cross-site browser requests', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://workspace.example');
    expect(isSameOriginMutation(request(undefined, { 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });
  it('rejects a missing origin', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://workspace.example');
    expect(isSameOriginMutation(request(''))).toBe(false);
  });
});

// P2 additions: bounded bytes and strict object fields, not a Content-Length trust check.
describe('bounded JSON records', () => {
  const body = (value: string) => new Request('https://workspace.example', { method: 'POST', body: value });
  it('accepts exactly 16 KiB and rejects one byte more', async () => {
    await expect(readSmallJson(body('"' + 'x'.repeat(16382) + '"'))).resolves.toHaveLength(16382);
    await expect(readSmallJson(body('"' + 'x'.repeat(16383) + '"'))).rejects.toThrow();
  });
  it.each(['null', '[]', 'true', '1', '{"unexpected":1}', 'not json'])('rejects nonempty/invalid empty-action body %s', async value => {
    await expect(readJsonRecord(body(value), [])).rejects.toThrow();
  });
  it('accepts the explicit empty JSON action contract', async () => {
    await expect(readJsonRecord(body('{}'), [])).resolves.toEqual({});
  });
  it.each(['http://workspace.example', 'https://workspace.example/', 'https://user@workspace.example', 'https://workspace.example/path', 'https://workspace.example?x=1', 'https://workspace.example#x'])('rejects noncanonical origin configuration %s', value => {
    vi.stubEnv('TUGPT_APP_ORIGIN', value);
    expect(isSameOriginMutation(request())).toBe(false);
  });
});
