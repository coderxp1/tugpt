// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTranslator } from '@/i18n';
import { resolveProducts } from '@/lib/hub/products';
import { UNAVAILABLE_SIGNALS, type HubSignals } from '@/lib/hub/signals';
import { BLUEPRINT_AREAS } from '@/lib/hub/capabilities';
import { ProductHub } from './ProductHub';
vi.mock('@/lib/supabase/server', () => ({ createFeatureServerClient: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useRouter: () => ({ refresh }) }));
vi.mock('next/link', () => ({ default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean }) => <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a> }));
const signals: HubSignals = { needsHuman: 2, openConversations: 9, draftsAwaitingReview: 0, knowledgeEntries: 14, activeMediaJobs: 0, whatsapp: 'none', calendar: 'connected' };
function renderHub(s: HubSignals = signals, organizationName: string | null = 'TuGPT') {
 return render(<ProductHub organizationName={organizationName} email="owner@example.com" role="owner" products={resolveProducts(s)} t={createTranslator('en')} />);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('reference-based working Dashboard', () => {
 it('renders the organization, account and English greeting', () => { renderHub(); expect(screen.getAllByText('TuGPT').length).toBeGreaterThan(0); expect(screen.getByText('owner@example.com')).toBeTruthy(); expect(screen.getByRole('heading', {name:'Good to have you here.'})).toBeTruthy(); });
 it('preserves every implemented destination instead of opening dialogs', () => {
  renderHub(); const list=screen.getByRole('list',{name:'TuGPT products'});
  expect(within(list).getAllByRole('link').map(a=>a.getAttribute('href')).sort()).toEqual(['/workspace','/dashboard/inbox','/dashboard/drafts','/dashboard/knowledge','/dashboard/analytics'].sort());
  expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('represents exactly all fourteen official Blueprint areas', () => {
  const {container}=renderHub(); const areas=new Set(Array.from(container.querySelectorAll('[data-blueprint-area]')).map(n=>n.getAttribute('data-blueprint-area')));
  expect([...areas].sort()).toEqual([...BLUEPRINT_AREAS].sort()); expect(areas.size).toBe(14);
 });
 it('links Chat, and does not fabricate actions for planned capabilities', () => {
  const {container}=renderHub(); expect(container.querySelector('[data-capability="workspace"] a')?.getAttribute('href')).toBe('/workspace');
  for(const id of ['media','calendar','whatsapp','voice','crm','research','agents','privacy','developer','mcp']) expect(container.querySelector(`[data-capability="${id}"] a`)).toBeNull();
  expect(container.querySelectorAll('a[href*="workspace.tugpt.pro"]').length).toBe(0);
 });
 it('preserves attention and real metrics', () => { renderHub(); expect(screen.getByRole('link',{name:/Conversations · 2 need a person/}).getAttribute('href')).toBe('/dashboard/inbox'); expect(screen.getByText(/Available · 14/)).toBeTruthy(); });
 it('never substitutes zero when a data source is unavailable', () => {
  // Isolate activity failure from the separately tested unknown feature-access state.
  renderHub({ ...UNAVAILABLE_SIGNALS, draftFeatureEnabled: true });
  expect(screen.getByText(/Some activity could not be read/)).toBeTruthy();
  expect(screen.getAllByText('Activity unavailable').length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/Available \u00b7 0/)).toHaveLength(0);
 });
 it('searches capabilities and provides a useful empty state', () => {
  renderHub(); fireEvent.change(screen.getByRole('searchbox'),{target:{value:'CRM'}}); expect(screen.getByText('CRM Hub')).toBeTruthy(); expect(within(screen.getByRole('list',{name:'TuGPT products'})).queryByText('Media Studio')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'no-matches'}}); expect(screen.getByText(/No capabilities found/)).toBeTruthy(); fireEvent.click(screen.getByRole('button',{name:'Clear search'})); expect(within(screen.getByRole('list',{name:'TuGPT products'})).getByText('Media Studio')).toBeTruthy();
 });
 it('refreshes server data through Next, not simulated counts', () => { renderHub(); fireEvent.click(screen.getByRole('button',{name:'Refresh activity'})); expect(refresh).toHaveBeenCalledOnce(); });
 it('does not offer module actions without organization context', () => { renderHub(signals,null); expect(within(screen.getByRole('list',{name:'TuGPT products'})).queryAllByRole('link')).toHaveLength(0); expect(screen.getByText(/Organization unavailable. Capabilities require/)).toBeTruthy(); });
 it('reports disabled organization features without hiding existing destinations', () => { renderHub({...signals,draftFeatureEnabled:false,mediaFeatureEnabled:false}); expect(screen.getAllByText(/Not enabled for this organization/)).toHaveLength(3); expect(screen.getByRole('list',{name:'TuGPT products'}).querySelector('a[href="/dashboard/knowledge"]')).toBeTruthy(); });
 it('reports an unreadable feature flag honestly', () => { renderHub({...signals,draftFeatureEnabled:null,mediaFeatureEnabled:null}); expect(screen.getAllByText(/Availability unknown/)).toHaveLength(3); });
 it('keeps sign-out unprefetched', () => { renderHub(); expect(screen.getByRole('link',{name:/Sign out/}).getAttribute('data-prefetch')).toBe('false'); });
 it('offers mobile navigation, Escape dismissal and a skip link', () => {
  renderHub(); const menu=screen.getByRole('button',{name:'Open navigation'}); fireEvent.click(menu); expect(menu.getAttribute('aria-expanded')).toBe('true'); fireEvent.keyDown(document,{key:'Escape'}); expect(menu.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(menu); expect(screen.getByRole('link',{name:'Skip to content'}).getAttribute('href')).toBe('#contenido');
 });
});

it('offers explicit organization selection while held flags never activate controls', () => {
  const { container } = renderHub({ ...signals, mediaFeatureEnabled: true });
  expect(screen.queryByRole('button', { name: 'Switch organization' })).toBeNull();
  expect(container.querySelector('a[href="/dashboard/media"]')).toBeNull();
  expect(container.querySelector('a[href="/settings/integrations"]')).toBeNull();
  expect(screen.getAllByText('On hold pending review').length).toBeGreaterThan(0);
});

// Per-capability strengthening: the existing count of THREE is intentional.
// Conversations, drafts and knowledge share the ordinary draft feature gate.
it.each([false, null, true] as const)('keeps ordinary feature state separate from unconditional holds: %s', (flag) => {
  const { container } = renderHub({ ...signals, draftFeatureEnabled: flag, mediaFeatureEnabled: flag });
  const products = resolveProducts({ ...signals, draftFeatureEnabled: flag, mediaFeatureEnabled: flag });
  for (const id of ['conversations', 'drafts', 'knowledge']) {
    expect(products.find(p => p.id === id)?.featureAccess).toBe(flag === null ? 'unknown' : flag ? 'enabled' : 'disabled');
    expect(screen.getByRole('list', { name: 'TuGPT products' }).querySelector(`a[href="${products.find(p => p.id === id)?.href}"]`)).toBeTruthy();
  }
  for (const id of ['media', 'calendar', 'whatsapp']) {
    expect(products.find(p => p.id === id)?.state).toBe('held');
    expect(products.find(p => p.id === id)?.featureAccess).toBeUndefined();
    expect(container.querySelector(`[data-capability="${id}"] a`)).toBeNull();
  }
});

describe('Overview follows the organization feature map', () => {
  const hub = (features: Record<string, string>) => render(<ProductHub organizationName="TuGPT" email="owner@example.com" role="owner" features={features as never} products={resolveProducts({ ...signals, draftFeatureEnabled: false })} t={createTranslator('en')} />);
  it('links MCP only while it is usable and matches the sidebar wording', () => {
    const on = hub({ mcp: 'available', chat: 'available' });
    expect(on.container.querySelector('[data-capability="mcp"] a')?.getAttribute('href')).toBe('/dashboard/connect#mcp-title');
    cleanup();
    const off = hub({ mcp: 'disabled', chat: 'available' });
    expect(off.container.querySelector('[data-capability="mcp"] a')).toBeNull();
    expect(off.container.querySelector('[data-capability="mcp"]')?.textContent).toMatch(/Not enabled/);
  });
  it('labels partly available features and never shows counts for disabled ones', () => {
    const { container } = hub({ analytics: 'partial', inbox: 'disabled', drafts: 'disabled', knowledge: 'disabled', chat: 'available' });
    expect(container.querySelector('[data-capability="analytics"]')?.textContent).toMatch(/Partly available/);
    expect(container.querySelector('[data-capability="conversations"]')?.textContent).not.toMatch(/\d+ (open|need)/);
    expect(container.querySelector('[data-capability="knowledge"]')?.textContent).not.toMatch(/·\s*14/);
  });
  it('shows no developer wording', () => {
    const { container } = hub({ chat: 'available' });
    expect(container.textContent).not.toMatch(/Blueprint|feature flag|webhook|Staging|APIs exist|regardless of/i);
  });
});
