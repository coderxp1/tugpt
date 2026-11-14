import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSecureOrigin, sessionCookieOptions } from './cookie-options';

describe('session cookie options', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('treats only https origins as secure', () => {
    expect(isSecureOrigin('https://dashboard.tugpt.pro')).toBe(true);
    expect(isSecureOrigin(' HTTPS://dashboard.tugpt.pro ')).toBe(true);
    expect(isSecureOrigin('http://127.0.0.1:3003')).toBe(false);
    expect(isSecureOrigin('')).toBe(false);
    expect(isSecureOrigin(undefined)).toBe(false);
  });

  it('marks cookies Secure on an HTTPS deployment (server side)', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'https://dashboard.tugpt.pro');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://dashboard.tugpt.pro');
    expect(sessionCookieOptions()).toEqual({ secure: true, sameSite: 'lax', path: '/' });
  });

  it('keeps local HTTP development working', () => {
    vi.stubEnv('TUGPT_APP_ORIGIN', 'http://127.0.0.1:3003');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    expect(sessionCookieOptions().secure).toBe(false);
  });
});
