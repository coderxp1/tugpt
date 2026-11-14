// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTranslator } from '@/i18n';
import { resolveProducts } from '@/lib/hub/products';
import { UNAVAILABLE_SIGNALS, type HubSignals } from '@/lib/hub/signals';
import { BLUEPRINT_AREAS } from '@/lib/hub/capabilities';
import { ProductHub } from './ProductHub';
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
  expect(within(list).getAllByRole('link').map(a=>a.getAttribute('href')).sort()).toEqual(['/dashboard/inbox','/dashboard/drafts','/dashboard/knowledge','/dashboard/media','/settings/integrations','/dashboard/analytics'].sort());
  expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('represents exactly all fourteen official Blueprint areas', () => {
  const {container}=renderHub(); const areas=new Set(Array.from(container.querySelectorAll('[data-blueprint-area]')).map(n=>n.getAttribute('data-blueprint-area')));
  expect([...areas].sort()).toEqual([...BLUEPRINT_AREAS].sort()); expect(areas.size).toBe(14);
 });
 it('does not link Workspace or fabricate actions for planned capabilities', () => {
  const {container}=renderHub(); for(const id of ['workspace','voice','crm','research','agents','privacy','developer','mcp']) expect(container.querySelector(`[data-capability="${id}"] a`)).toBeNull();
  expect(container.querySelectorAll('a[href*="workspace.tugpt.pro"]').length).toBe(0);
 });
 it('preserves attention and real metrics', () => { renderHub(); expect(screen.getByRole('link',{name:/Conversations · 2 need a person/}).getAttribute('href')).toBe('/dashboard/inbox'); expect(screen.getByText(/Available · 14/)).toBeTruthy(); });
 it('never substitutes zero when a data source is unavailable', () => { renderHub(UNAVAILABLE_SIGNALS); expect(screen.getByText(/Some activity could not be read/)).toBeTruthy(); expect(screen.getAllByText('Activity unavailable').length).toBeGreaterThan(0); });
 it('searches capabilities and provides a useful empty state', () => {
  renderHub(); fireEvent.change(screen.getByRole('searchbox'),{target:{value:'CRM'}}); expect(screen.getByText('CRM Hub')).toBeTruthy(); expect(screen.queryByText('Media Studio')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'no-matches'}}); expect(screen.getByText(/No capabilities found/)).toBeTruthy(); fireEvent.click(screen.getByRole('button',{name:'Clear search'})); expect(screen.getByText('Media Studio')).toBeTruthy();
 });
 it('refreshes server data through Next, not simulated counts', () => { renderHub(); fireEvent.click(screen.getByRole('button',{name:'Refresh activity'})); expect(refresh).toHaveBeenCalledOnce(); });
 it('does not offer module actions without organization context', () => { renderHub(signals,null); expect(within(screen.getByRole('list',{name:'TuGPT products'})).queryAllByRole('link')).toHaveLength(0); expect(screen.getByText(/Organization unavailable. Capabilities require/)).toBeTruthy(); });
 it('reports disabled organization features without hiding existing destinations', () => { renderHub({...signals,draftFeatureEnabled:false,mediaFeatureEnabled:false}); expect(screen.getAllByText(/Not enabled for this organization/)).toHaveLength(4); expect(screen.getByRole('list',{name:'TuGPT products'}).querySelector('a[href="/dashboard/knowledge"]')).toBeTruthy(); });
 it('reports an unreadable feature flag honestly', () => { renderHub({...signals,draftFeatureEnabled:null,mediaFeatureEnabled:null}); expect(screen.getAllByText(/Availability unknown/)).toHaveLength(4); });
 it('keeps sign-out unprefetched', () => { renderHub(); expect(screen.getByRole('link',{name:/Sign out/}).getAttribute('data-prefetch')).toBe('false'); });
 it('offers mobile navigation, Escape dismissal and a skip link', () => {
  renderHub(); const menu=screen.getByRole('button',{name:'Open navigation'}); fireEvent.click(menu); expect(menu.getAttribute('aria-expanded')).toBe('true'); fireEvent.keyDown(document,{key:'Escape'}); expect(menu.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(menu); expect(screen.getByRole('link',{name:'Skip to content'}).getAttribute('href')).toBe('#contenido');
 });
});
