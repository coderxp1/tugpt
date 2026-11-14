import { describe, expect, it, vi } from 'vitest';
import { getRequestLocale } from './server';
import { DEFAULT_LOCALE } from './index';
vi.mock('@/lib/tenant/server', () => ({ getSessionContext: () => ({ tenant: { locale: 'es' } }) }));
describe('English-first Dashboard policy', () => {
 it('uses English even when the stored organization locale is Spanish', async () => { expect(await getRequestLocale()).toBe('en'); });
 it('defaults unwrapped client components to English', () => { expect(DEFAULT_LOCALE).toBe('en'); });
});
