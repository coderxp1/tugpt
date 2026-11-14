import { describe, expect, it, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, classifyRoute } from '@/proxy';
import { createAdminSupabaseClient } from '@tugpt/database';
import { resolveProducts } from '@/lib/hub/products';
import { UNAVAILABLE_SIGNALS } from '@/lib/hub/signals';
vi.mock('@/lib/supabase/server', () => ({ createFeatureServerClient: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());
describe('ordinary and held separation', () => {
  it.each(['/api/v1/media', '/api/v1/integrations', '/api/v1/workspace', '/api/v1/webhooks'])('holds %s before contacting the session store', async prefix => {
    for (const suffix of ['', '/x']) {
      const response = await proxy(new NextRequest('https://dashboard.example' + prefix + suffix));
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'privileged_bridge_pending_review' });
    }
    expect(classifyRoute(prefix + 'other')).toBe('protected');
  });
  it('prohibits direct admin client construction in the independent Dashboard context', () => {
    vi.stubEnv('TUGPT_DASHBOARD_POSTGREST_URL', 'http://127.0.0.1:3002');
    expect(() => createAdminSupabaseClient('https://unused.example', 'synthetic')).toThrow(/Privileged SSO adapter/);
  });
  it('leaves ordinary destinations available but never derives held routes from flags', () => {
    const products = resolveProducts({ ...UNAVAILABLE_SIGNALS, draftFeatureEnabled: false, mediaFeatureEnabled: true });
    for (const id of ['conversations', 'drafts', 'knowledge', 'analytics']) expect(products.find(p => p.id === id)?.href).toBeTruthy();
    for (const id of ['media', 'calendar', 'whatsapp', 'workspace']) expect(products.find(p => p.id === id)?.href).toBeNull();
  });
});
