import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); });
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('@/i18n/server', () => ({ getRequestLocale: async () => 'en' }));

import IntegrationsPage from './page';

describe('/settings/integrations', () => {
  it('forwards an OAuth return to Connect with whitelisted values only', async () => {
    await expect(IntegrationsPage({ searchParams: Promise.resolve({ google: 'error', reason: '<x>', next: 'https://evil.example' }) }))
      .rejects.toThrow('REDIRECT:/dashboard/connect?google=error&reason=unknown');
    await expect(IntegrationsPage({ searchParams: Promise.resolve({ microsoft: 'connected' }) }))
      .rejects.toThrow('REDIRECT:/dashboard/connect?microsoft=connected');
  });
  it('keeps the held page otherwise', async () => {
    redirect.mockClear();
    const el = await IntegrationsPage({ searchParams: Promise.resolve({}) });
    expect(el).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});
