import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createAuthenticatedServerClient, createFeatureServerClient } from './server';
const mocks = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn(), fetch: vi.fn(), bridge: vi.fn(() => 'unit-bridge'), headers: new Headers(), options: null as any }));
vi.mock('next/headers', () => ({ headers: async () => mocks.headers, cookies: async () => ({ getAll: () => [] }) }));
vi.mock('@tugpt/database', () => ({ createSupabaseClient: (...args: any[]) => { mocks.options = args[2]; mocks.create(...args); return { auth: {} }; } }));
vi.mock('@/lib/sso/core', async original => ({ ...await original<typeof import('@/lib/sso/core')>(), loadSession: mocks.load, bridgeToken: mocks.bridge, dbUrl: () => 'http://127.0.0.1:3002' }));
beforeEach(() => { vi.clearAllMocks(); mocks.headers = new Headers(); mocks.load.mockResolvedValue(null); vi.stubGlobal('fetch', mocks.fetch); mocks.fetch.mockResolvedValue(Response.json([])); });
afterEach(() => vi.unstubAllGlobals());
it('retains raw duplicate cookies for the frozen loader, rather than selecting one', async () => {
  mocks.headers.set('cookie', '__Host-tugpt_session=one; __Host-tugpt_session=two');
  await createAuthenticatedServerClient(); expect(mocks.load).toHaveBeenCalledWith(mocks.headers.get('cookie'));
});
it('has no legacy auth or admin fallback for missing identity', async () => {
  const client = await createAuthenticatedServerClient(); expect((await client.auth.getUser()).data.user).toBeNull();
  expect((await mocks.options.global.fetch('http://127.0.0.1:3002/rest/v1/profiles')).status).toBe(401); expect(mocks.fetch).not.toHaveBeenCalled();
  await expect(createFeatureServerClient('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).rejects.toThrow();
});
it('locks ordinary requests to the configured origin and public profile', async () => {
  mocks.load.mockResolvedValue({ subject: 'user', mapped: true }); await createAuthenticatedServerClient();
  for (const url of ['https://other.example/rest/v1/profiles', 'http://127.0.0.1:3002/auth/v1/user']) await expect(mocks.options.global.fetch(url)).rejects.toThrow();
  await expect(mocks.options.global.fetch('http://127.0.0.1:3002/rest/v1/profiles', { headers: { 'Accept-Profile': 'sso' } })).rejects.toThrow();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('replaces credentials while retaining Request method and body', async () => {
  mocks.load.mockResolvedValue({ subject: 'user', mapped: true }); await createAuthenticatedServerClient();
  await mocks.options.global.fetch(new Request('http://127.0.0.1:3002/rest/v1/rpc/example', { method: 'POST', body: '{}', headers: { authorization: 'Bearer caller', apikey: 'caller' } }));
  const [outgoing, options] = mocks.fetch.mock.calls[0];
  expect(outgoing.url).toBe('http://127.0.0.1:3002/rpc/example'); expect(outgoing.method).toBe('POST'); expect(await outgoing.text()).toBe('{}');
  expect(options.headers.get('authorization')).toBe('Bearer unit-bridge'); expect(options.headers.has('apikey')).toBe(false);
  expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
  expect(mocks.options.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
});
