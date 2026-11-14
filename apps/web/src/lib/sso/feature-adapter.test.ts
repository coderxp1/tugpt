import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { scopedFeatureAdapter } from './feature-adapter';
import type { AppSession } from './core';
const mocks = vi.hoisted(() => ({ bridge: vi.fn(() => 'synthetic-unit-assertion') }));
vi.mock('./core', async original => ({ ...await original<typeof import('./core')>(), bridgeToken: mocks.bridge, dbUrl: () => 'http://127.0.0.1:3002' }));
const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const session = { subject: '11111111-1111-1111-1111-111111111111', auth_session: '22222222-2222-2222-2222-222222222222', hash: 'a'.repeat(64), mapped: true, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, expires_at: new Date(Date.now() + 60000).toISOString() } as AppSession;
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
it('allows only the exact tenant/feature RPC and sends no caller-selected operation', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(true));
  const client = scopedFeatureAdapter(session, org, fetcher);
  const result = await client.rpc('is_feature_enabled', { p_organization_id: org, p_flag_key: 'ai_draft_generation' });
  expect(result.data).toBe(true);
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3002/rpc/feature_enabled', expect.objectContaining({ redirect: 'error', cache: 'no-store', method: 'POST' }));
  expect(mocks.bridge).toHaveBeenCalledWith('authenticated', session);
});
it.each([
  ['anything_else', org, 'ai_draft_generation'],
  ['is_feature_enabled', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ai_draft_generation'],
  ['is_feature_enabled', org, 'unreviewed_flag'],
])('rejects widening %s %s %s before transport', async (fn, tenant, flag) => {
  const fetcher = vi.fn(); const client = scopedFeatureAdapter(session, org, fetcher);
  const result = await (client.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }>)(fn, { p_organization_id: tenant, p_flag_key: flag });
  expect(result.error).toBeTruthy(); expect(fetcher).not.toHaveBeenCalled();
});
it('rejects unmapped identities and malformed organization ids', () => {
  expect(() => scopedFeatureAdapter({ ...session, mapped: false }, org)).toThrow();
  expect(() => scopedFeatureAdapter(session, 'bad')).toThrow();
});
it.each([true, false, null, {}, []])('accepts only scalar boolean response %j', async value => {
  const result = await scopedFeatureAdapter(session, org, vi.fn().mockResolvedValue(Response.json(value))).rpc('is_feature_enabled', { p_organization_id: org, p_flag_key: 'ai_draft_generation' });
  expect(Boolean(result.error)).toBe(typeof value !== 'boolean');
});
