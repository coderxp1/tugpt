import { vi } from 'vitest';
vi.mock('@/lib/supabase/server', () => ({ createFeatureServerClient: vi.fn() }));
import { describe, expect, it } from 'vitest';
import { PRODUCTS, attentionCount, resolveProducts, type ProductId } from './products';
import { UNAVAILABLE_SIGNALS, summarizeWhatsapp, type HubSignals } from './signals';
import { NAV_ITEMS } from '@/components/shell/nav-items';

const healthy: HubSignals = {
  needsHuman: 0,
  openConversations: 12,
  draftsAwaitingReview: 0,
  knowledgeEntries: 40,
  activeMediaJobs: 1,
  whatsapp: 'active',
  calendar: 'connected',
};

const byId = (signals: HubSignals) =>
  Object.fromEntries(resolveProducts(signals).map((p) => [p.id, p])) as Record<
    ProductId,
    ReturnType<typeof resolveProducts>[number]
  >;

describe('the product registry', () => {
  it('lists each product once', () => {
    const ids = PRODUCTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('links only to real pages that the primary navigation also reaches', () => {
    // A hub link to a route the tools do not serve would be a dead end
    // dressed up as a product. Every href must be a nav destination.
    const navHrefs = new Set(NAV_ITEMS.map((n) => n.href));
    for (const p of PRODUCTS) {
      if (p.href !== null) expect(navHrefs.has(p.href), p.id).toBe(true);
    }
  });

  it('links the Workspace entry to Chat, which is built', () => {
    const ws = PRODUCTS.find((p) => p.id === 'workspace');
    expect(ws?.href).toBe('/workspace');
    expect(byId(healthy).workspace.state).toBe('live');
  });

  it('does not link WhatsApp, which has no self-service page yet', () => {
    expect(PRODUCTS.find((p) => p.id === 'whatsapp')?.href).toBeNull();
  });
});

describe('signals become honest states', () => {
  it('shows a healthy organization as live and connected with nothing waiting', () => {
    const v = byId(healthy);
    expect(v.conversations.state).toBe('live');
    expect(v.conversations.metric).toBe(12);
    expect(v.drafts.state).toBe('live');
    expect(v.calendar.state).toBe('held');
    expect(v.whatsapp.state).toBe('held');
    expect(attentionCount(resolveProducts(healthy))).toBe(0);
  });

  it('raises conversations needing a person and drafts awaiting review as attention', () => {
    const v = byId({ ...healthy, needsHuman: 3, draftsAwaitingReview: 5 });
    expect(v.conversations.state).toBe('attention');
    expect(v.conversations.metric).toBe(3);
    expect(v.conversations.metricKey).toBe('hub.metric.needsHuman');
    expect(v.drafts.state).toBe('attention');
    expect(v.drafts.metric).toBe(5);
    expect(attentionCount(resolveProducts({ ...healthy, needsHuman: 3, draftsAwaitingReview: 5 }))).toBe(2);
  });

  it('never turns an unreadable signal into zero or healthy', () => {
    const products = resolveProducts(UNAVAILABLE_SIGNALS);
    for (const p of products) {
      if (p.id === 'analytics' || p.id === 'workspace') continue;
      expect(p.state, p.id).toBe(['media', 'calendar', 'whatsapp'].includes(p.id) ? 'held' : 'unknown');
      expect(p.metric, p.id).toBeNull();
    }
    expect(attentionCount(products)).toBe(0);
  });

  it('marks an expired calendar credential and a failed WhatsApp connection as attention', () => {
    const v = byId({ ...healthy, calendar: 'expired', whatsapp: 'error' });
    expect(v.calendar.state).toBe('held');
    expect(v.whatsapp.state).toBe('held');
  });

  it('asks for setup when nothing is connected or no knowledge exists', () => {
    const v = byId({ ...healthy, calendar: 'available', whatsapp: 'none', knowledgeEntries: 0 });
    expect(v.calendar.state).toBe('held');
    expect(v.whatsapp.state).toBe('held');
    expect(v.knowledge.state).toBe('setup');
  });
});

describe('summarizeWhatsapp', () => {
  it('prefers active, then error, then pending, and reports none for no rows', () => {
    expect(summarizeWhatsapp([{ status: 'pending' }, { status: 'active' }])).toBe('active');
    expect(summarizeWhatsapp([{ status: 'pending' }, { status: 'error' }])).toBe('error');
    expect(summarizeWhatsapp([{ status: 'pending' }])).toBe('pending');
    expect(summarizeWhatsapp([])).toBe('none');
  });

  it('treats a malformed response as unreadable, not as disconnected', () => {
    expect(summarizeWhatsapp(null)).toBeNull();
    expect(summarizeWhatsapp({ status: 'active' })).toBeNull();
  });
});

it('held products never acquire links or metrics from enabled flags', () => {
  for (const p of resolveProducts({ ...healthy, mediaFeatureEnabled: true })) {
    if (!['media', 'calendar', 'whatsapp'].includes(p.id)) continue;
    expect(p.href).toBeNull(); expect(p.metric).toBeNull(); expect(p.state).toBe('held');
  }
});
