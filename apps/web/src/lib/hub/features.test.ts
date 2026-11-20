import { describe, expect, it } from 'vitest';
import { describeFeatures, featureMap, isUsable, type FeatureFacts } from './features';

const base: FeatureFacts = { draftsEnabled: false, google: 'off', microsoft: 'off', mcpManage: false, mcpChat: false, imagesConfigured: false, hasChatModel: true };
const by = (f: FeatureFacts) => featureMap(describeFeatures(f));

describe('describeFeatures', () => {
  it('reports nothing as available that a gate did not open', () => {
    const m = by(base);
    expect(m.chat).toBe('available');
    for (const k of ['inbox', 'drafts', 'knowledge', 'mcp', 'mcp_chat', 'images', 'media'] as const) expect(m[k], k).toBe('disabled');
    // A provider TuGPT does not offer yet reads "Not available yet", as on the Connect page.
    expect(m.google).toBe('not_implemented'); expect(m.microsoft).toBe('not_implemented');
    expect(by({ ...base, google: 'unknown' }).google).toBe('disabled');
    expect(m.agents).toBe('not_implemented'); expect(m.crm).toBe('not_implemented'); expect(m.video).toBe('not_implemented');
    expect(m.team).toBe('partial'); expect(m.analytics).toBe('partial');
  });
  it('treats an unreadable draft gate as not enabled, never available', () => {
    const list = describeFeatures({ ...base, draftsEnabled: null });
    const inbox = list.find((f) => f.key === 'inbox')!;
    expect(inbox.state).toBe('disabled'); expect(inbox.detail).toMatch(/could not be checked/);
  });
  it('opens draft features, MCP and providers only when their gates say so', () => {
    const m = by({ ...base, draftsEnabled: true, google: 'connected', microsoft: 'ready', mcpManage: true, mcpChat: true, imagesConfigured: true });
    expect([m.inbox, m.drafts, m.knowledge, m.google, m.microsoft, m.mcp, m.mcp_chat, m.images]).toEqual(Array(8).fill('available'));
    expect(m.media).toBe('disabled');
  });
  it('never names a flag, URL or route in customer text', () => {
    for (const f of describeFeatures({ ...base, draftsEnabled: null, google: 'unknown' })) expect(f.detail, f.key).not.toMatch(/TUGPT_|\/api\/|https?:|B-\d/);
  });
  it('isUsable is true only for available and partial', () => {
    expect([isUsable('available'), isUsable('partial'), isUsable('disabled'), isUsable('not_implemented'), isUsable(undefined)]).toEqual([true, true, false, false, false]);
  });
});
