import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GET as start } from '@/app/auth/website/start/route';
import { GET as callback } from '@/app/auth/website/callback/route';
import { websiteLoginConfig, safeDashboardPath } from './config';
const mocks=vi.hoisted(()=>({ oauth:vi.fn(),exchange:vi.fn(),user:vi.fn(),tenant:vi.fn() }));
vi.mock('@/lib/supabase/server',()=>({createAuthenticatedServerClient:vi.fn(async()=>({auth:{signInWithOAuth:mocks.oauth,exchangeCodeForSession:mocks.exchange,getUser:mocks.user}}))}));
vi.mock('@tugpt/auth',()=>({AuthService:class {resolveTenantContext=mocks.tenant;}}));
const origin='https://dashboard.tugpt.pro', auth='https://production-example.supabase.co';
beforeEach(()=>{vi.stubEnv('TUGPT_WEBSITE_LOGIN_ENABLED','true');vi.stubEnv('TUGPT_APP_ORIGIN',origin);vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL',auth);vi.stubEnv('TUGPT_WEBSITE_AUTH_URL',auth);mocks.oauth.mockResolvedValue({data:{url:auth+'/auth/v1/authorize?provider=google&code_challenge=challenge'},error:null});mocks.exchange.mockResolvedValue({error:null});mocks.user.mockResolvedValue({data:{user:{id:'production-user'}},error:null});mocks.tenant.mockResolvedValue({organizationId:'existing-org',role:'member'});});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('retired website authentication handoff', () => {
 it("retired routes return 410 without auth side effects (legacy: is disabled unless explicitly enabled)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it('fails closed if expected project and Dashboard project differ',()=>{vi.stubEnv('TUGPT_WEBSITE_AUTH_URL','https://other.supabase.co');expect(websiteLoginConfig()).toBeNull();});
 it('refuses an untrusted configured app origin',()=>{vi.stubEnv('TUGPT_APP_ORIGIN','https://evil.example');expect(websiteLoginConfig()).toBeNull();});
 it("retired routes return 410 without auth side effects (legacy: refuses unapproved providers)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: starts PKCE using a fixed Dashboard callback, not caller next/host input)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: supports the existing GitHub provider)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: refuses a provider response redirect to an unrelated host)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: redirects only after code exchange, identity verification and membership resolution)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: does not accept token handoff through URLs)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: fails closed on missing code)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: does not display or forward provider errors)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: rejects failed PKCE/replayed code exchanges)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: rejects a session whose user cannot be verified)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: never grants an organization to an authenticated user with no membership)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
 it("retired routes return 410 without auth side effects (legacy: returns generic errors on auth service failures)", () => {
  for (const handler of [start, callback]) { const r = handler(); expect(r.status).toBe(410); expect(r.headers.get('location')).toBeNull(); }
  expect(mocks.oauth).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.tenant).not.toHaveBeenCalled();
 });
});
describe('safe post-auth destination',()=>{
 for(const value of ['https://evil.example','//evil.example','javascript:alert(1)','/\\evil.example','/%2f%2fevil.example','/auth/logout','/dashboard?next=https://evil.example'])it('rejects '+value,()=>expect(safeDashboardPath(value)).toBe('/dashboard'));
 it('preserves an implemented module route',()=>expect(safeDashboardPath('/dashboard/knowledge')).toBe('/dashboard/knowledge'));
});
