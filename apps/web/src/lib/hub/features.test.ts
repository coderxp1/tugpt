import { describe, expect, it } from 'vitest';
import { createTranslator } from '@/i18n';
import { describeFeatures, featureMap, isUsable, NOT_YET, sectionOf, stateLabel, type FeatureFacts, type FeatureStatus } from './features';

const base: FeatureFacts = { draftsEnabled: false, google: 'off', microsoft: 'off', mcpManage: false, mcpChat: false, imagesConfigured: false, hasChatModel: true,
  workspaceDb: 'ok', libraryDb: 'ok', approvalsDb: 'ok', mcpActive: null, customAgents: false, canManage: true };
const by = (f: FeatureFacts) => featureMap(describeFeatures(f));
const one = (f: FeatureFacts, key: FeatureStatus['key']) => describeFeatures(f).find((x) => x.key === key)!;

describe('describeFeatures', () => {
  it('reports nothing as available that a gate did not open', () => {
    const m = by(base);
    expect([m.chat, m.library, m.approvals]).toEqual(['available', 'available', 'available']);
    for (const k of ['inbox', 'drafts', 'knowledge', 'mcp', 'images'] as const) expect(m[k], k).toBe('disabled');
    expect([m.mcp_chat, m.media, m.custom_agents]).toEqual(['under_review', 'under_review', 'under_review']);
    // A provider TuGPT does not offer yet reads "Not available yet", as on the Connect page.
    expect(m.google).toBe('not_implemented'); expect(m.microsoft).toBe('not_implemented');
    expect(m.agents).toBe('not_implemented'); expect(m.crm).toBe('not_implemented'); expect(m.video).toBe('not_implemented');
    expect(m.team).toBe('partial'); expect(m.analytics).toBe('partial');
  });
  it('never turns an unreadable gate into "available"', () => {
    const m = by({ ...base, draftsEnabled: null, google: 'unknown', microsoft: 'unknown', mcpManage: true, mcpActive: null, workspaceDb: 'unknown', libraryDb: undefined, approvalsDb: 'missing' });
    for (const k of ['inbox', 'drafts', 'knowledge', 'google', 'microsoft', 'mcp', 'chat', 'library', 'approvals'] as const) expect(m[k], k).toBe('unknown');
  });
  it('opens features only when their gates say so', () => {
    const m = by({ ...base, draftsEnabled: true, google: 'connected', mcpManage: true, mcpActive: true, mcpChat: true, imagesConfigured: true, customAgents: true });
    expect([m.inbox, m.drafts, m.knowledge, m.google, m.mcp, m.mcp_chat, m.images, m.custom_agents]).toEqual(Array(8).fill('available'));
    expect(m.media).toBe('under_review');
  });
  it('turns a ready provider and an empty MCP layer into setup with a real destination', () => {
    const f = { ...base, microsoft: 'ready' as const, mcpManage: true, mcpActive: false };
    const ms = one(f, 'microsoft'); const mcp = one(f, 'mcp');
    expect(ms.state).toBe('setup_required'); expect(ms.action).toEqual({ href: '/dashboard/connect#provider-microsoft', label: 'Connect Microsoft 365' });
    expect(mcp.state).toBe('setup_required'); expect(mcp.action?.href).toBe('/dashboard/connect#mcp-title');
  });
  it('is role-aware: members get who-can-enable text instead of setup actions', () => {
    const f = { ...base, microsoft: 'ready' as const, mcpManage: true, mcpActive: false, canManage: false };
    for (const k of ['microsoft', 'mcp'] as const) { const s = one(f, k); expect(s.action, k).toBeNull(); expect(s.who, k).toMatch(/owner or administrator/i); }
    expect(one(f, 'inbox').who).toMatch(/Ask an owner or admin/i);
    expect(one(base, 'inbox').who).toMatch(/request/i);
    expect(one(f, 'team').action?.href).toBe('/dashboard/settings#members');
    expect(one(base, 'team').action?.href).toBe('/dashboard/settings#team');
    expect(one({ ...f, mcpActive: true }, 'mcp').action?.label).toBe('See tools');
    expect(one({ ...base, mcpManage: true, mcpActive: true }, 'mcp').action?.label).toBe('Manage tools');
  });
  it('routes every page-backed feature to a real page and keeps planned ones without a page', () => {
    const real = new Set(['/workspace', '/workspace/library', '/workspace/approvals', '/workspace/images', '/workspace/agents', '/dashboard/settings', '/dashboard/analytics', '/dashboard/connect', '/dashboard/inbox', '/dashboard/drafts', '/dashboard/knowledge', '/dashboard/media']);
    for (const s of describeFeatures(base)) {
      if (s.group === 'later') { expect(s.href, s.key).toBeNull(); expect(s.action, s.key).toBeNull(); continue; }
      for (const h of [s.href, s.action?.href].filter(Boolean) as string[]) expect(real.has(h.split('#')[0]!), `${s.key} ${h}`).toBe(true);
    }
  });
  it('never names a flag, URL or route in customer text, in either language', () => {
    for (const lang of ['en', 'es'] as const) for (const f of describeFeatures({ ...base, draftsEnabled: null, google: 'unknown', approvalsDb: 'missing', canManage: false }, createTranslator(lang)))
      for (const txt of [f.detail, f.who ?? '', f.name]) expect(txt, `${lang} ${f.key}`).not.toMatch(/TUGPT_|\/api\/|https?:|B-\d|feature flag|is_available|\benv\b|environment variable/i);
  });
  it('maps states to overview sections and labels', () => {
    expect(['available', 'partial', 'setup_required', 'disabled', 'under_review', 'unknown', 'not_implemented'].map((s) => sectionOf(s as never))).toEqual(['ready', 'ready', 'setup', 'disabled', 'review', 'unknown', 'later']);
    expect(stateLabel('setup_required')).toBe('Needs setup'); expect(stateLabel('under_review', createTranslator('es'))).not.toBe('Under review');
  });
  it('isUsable covers pages that work or are where setup happens', () => {
    expect([isUsable('available'), isUsable('partial'), isUsable('setup_required'), isUsable('disabled'), isUsable('under_review'), isUsable('not_implemented'), isUsable(undefined)]).toEqual([true, true, true, false, false, false, false]);
  });
  it('has translated names for every not-yet item', () => {
    for (const lang of ['en', 'es'] as const) { const t = createTranslator(lang); for (const k of NOT_YET) expect(t(`notyet.${k}`)).not.toBe(`notyet.${k}`); }
  });
});
