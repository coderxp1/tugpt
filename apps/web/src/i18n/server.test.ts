import { describe, expect, it, vi, beforeEach } from 'vitest';

const jar = { value: undefined as string | undefined, throws: false };
vi.mock('next/headers', () => ({
  cookies: async () => {
    if (jar.throws) throw new Error('outside a request');
    return { get: (n: string) => (n === 'tugpt_locale' && jar.value !== undefined ? { name: n, value: jar.value } : undefined) };
  },
}));
vi.mock('@/lib/tenant/server', () => ({ getSessionContext: () => ({ tenant: { locale: 'es' } }) }));

import { DEFAULT_LOCALE, localeCookie, parseLocalePreference } from './index';

async function fresh() {
  vi.resetModules();
  return (await import('./server')).getRequestLocale();
}

describe('Dashboard language preference', () => {
  beforeEach(() => { jar.value = undefined; jar.throws = false; });
  it('defaults to English, even when the stored organization locale is Spanish', async () => {
    expect(await fresh()).toBe('en');
    expect(DEFAULT_LOCALE).toBe('en');
  });
  it('uses Spanish only when the person chose it', async () => {
    jar.value = 'es';
    expect(await fresh()).toBe('es');
  });
  it('ignores unknown or tampered values and failures', async () => {
    for (const v of ['de', 'ES', '', 'es;', '<script>']) { jar.value = v; expect(await fresh()).toBe('en'); }
    jar.throws = true;
    expect(await fresh()).toBe('en');
    expect(parseLocalePreference(null)).toBe('en');
  });
  it('writes a site-wide, one-year, Secure, SameSite cookie', () => {
    expect(localeCookie('es')).toBe('tugpt_locale=es; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  });
});
