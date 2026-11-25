import { describe, expect, it } from 'vitest';
import { cookieValueFor, decideOperatorAccess, resolveAccessMode, timingSafeEqual, validCookie } from './access';
const TOKEN = 'test-owner-secret-0123456789abcdef';
describe('owner access policy', () => {
  it.each(['development', 'production', 'test', undefined])('fails closed in %s without a strong key', env => {
    expect(resolveAccessMode(env, undefined).mode).toBe('disabled');
    expect(resolveAccessMode(env, 'short')).toMatchObject({ mode: 'disabled', weakToken: true });
    expect(resolveAccessMode(env, TOKEN).mode).toBe('token');
    expect(decideOperatorAccess({ nodeEnv: env, configuredToken: undefined })).toMatchObject({ status: 404 });
  });
  it('uses fixed-length timing-safe digest comparison', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('requires a key or a signed, unexpired session', async () => {
    const base = { nodeEnv: 'production', configuredToken: TOKEN };
    expect(decideOperatorAccess(base)).toMatchObject({ status: 401 });
    expect(decideOperatorAccess({ ...base, headerValue: TOKEN })).toEqual({ kind: 'allow', via: 'header' });
    expect(decideOperatorAccess({ ...base, headerValue: TOKEN + 'x' })).toMatchObject({ status: 401 });
    const cookie = await cookieValueFor(TOKEN);
    expect(cookie).not.toContain(TOKEN);
    expect(decideOperatorAccess({ ...base, cookieValue: cookie })).toEqual({ kind: 'allow', via: 'cookie' });
    expect(decideOperatorAccess({ ...base, cookieValue: TOKEN })).toMatchObject({ status: 401 });
    expect(decideOperatorAccess({ ...base, cookieValue: cookie + 'a' })).toMatchObject({ status: 401 });
  });
  it('enforces expiry on the server and revokes sessions on key rotation', async () => {
    const now = 1793410000000;
    const cookie = await cookieValueFor(TOKEN, now);
    expect(validCookie(cookie, TOKEN, now)).toBe(true);
    expect(validCookie(cookie, TOKEN, now + 43200000)).toBe(false);
    expect(validCookie(cookie, TOKEN, now - 1000)).toBe(false);
    expect(validCookie(cookie, TOKEN + 'rotated', now)).toBe(false);
    expect(validCookie('invalid', TOKEN, now)).toBe(false);
  });
});
