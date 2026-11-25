// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

const nav = vi.hoisted(() => ({ path: '/dashboard/connect' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
vi.mock('@/i18n/provider', async () => { const { createTranslator } = await import('@/i18n'); const en = createTranslator('en'); return { useT: () => en }; });
import { DashboardFrame } from './DashboardFrame';
import type { FeatureKey, FeatureState } from '@/lib/hub/features';

afterEach(cleanup);
const ALL_ON: Partial<Record<FeatureKey, FeatureState>> = { chat: 'available', library: 'available', approvals: 'available', images: 'available', custom_agents: 'available', analytics: 'partial', inbox: 'available', drafts: 'available', knowledge: 'available', media: 'available' };
const side = () => screen.getByLabelText('Dashboard navigation');

describe('DashboardFrame navigation', () => {
  it('shows the signed-in person and the TuGPT brand; no organization line without one', () => {
    render(<DashboardFrame fullName="Anna Berger" email="anna@example.test" features={ALL_ON}><p>x</p></DashboardFrame>);
    expect(side().textContent).toContain('Anna Berger');
    expect(side().textContent).toContain('anna@example.test');
    expect(screen.getByRole('link', { name: 'TuGPT Dashboard' }).textContent).toContain('tugpt');
    expect(side().textContent).not.toMatch(/GmbH|Hartmann/i);
  });

  it('puts the Workspace first and makes every menu entry a real page', () => {
    render(<DashboardFrame email="anna@example.test" features={ALL_ON}><p>x</p></DashboardFrame>);
    const pill = screen.getByTestId('nav-open-workspace');
    expect(pill.getAttribute('href')).toBe('/workspace');
    const links = within(side()).getAllByRole('link');
    expect(links[1]).toBe(pill); // right after the TuGPT logo
    const hrefs = links.map((a) => a.getAttribute('href'));
    for (const h of ['/dashboard', '/workspace', '/workspace/library', '/workspace/approvals', '/workspace/images', '/workspace/agents', '/dashboard/connect', '/dashboard/settings', '/dashboard/analytics', '/dashboard/inbox', '/dashboard/drafts', '/dashboard/knowledge', '/dashboard/media'])
      expect(hrefs, h).toContain(h);
    // No dead ends: nothing points at a page that does not exist, and no non-link "planned" items.
    expect(hrefs).not.toContain('/dashboard/agents');
    expect(hrefs).not.toContain('/dashboard/chat');
    expect(side().querySelectorAll('nav span[aria-disabled], nav [data-planned]').length).toBe(0);
  });

  it('groups entries in labelled sections', () => {
    render(<DashboardFrame email="anna@example.test" features={ALL_ON}><p>x</p></DashboardFrame>);
    expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getAllByRole('link').map((a) => a.textContent)).toEqual(['Chat', 'Library', 'Approvals', 'Images', 'Agents']);
    expect(within(screen.getByRole('navigation', { name: 'Your organization' })).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/dashboard/connect', '/dashboard/settings', '/dashboard/analytics']);
    expect(within(screen.getByRole('navigation', { name: 'Customer messaging' })).getAllByRole('link')).toHaveLength(4);
  });

  it('tags entries with the real state, with the state separated for assistive tech', () => {
    render(<DashboardFrame email="anna@example.test" features={{ ...ALL_ON, inbox: 'disabled', media: 'under_review', images: 'disabled', custom_agents: 'under_review' }}><p>x</p></DashboardFrame>);
    const link = (h: string) => side().querySelector(`nav a[href="${h}"]`)!;
    expect(link('/dashboard/inbox').textContent).toBe('Conversations, Not enabled');
    expect(link('/dashboard/media').textContent).toBe('Media Studio, Under review');
    expect(link('/workspace/images').getAttribute('data-state')).toBe('disabled');
    expect(link('/workspace/agents').textContent).toContain('Under review');
    expect(link('/dashboard/drafts').textContent).toBe('AI Drafts');
    expect(link('/dashboard/analytics').textContent).toBe('Usage & Costs'); // partial works; no tag
  });

  it('shows "Couldn\'t check" instead of nothing when a state is missing', () => {
    render(<DashboardFrame email="anna@example.test"><p>x</p></DashboardFrame>);
    expect(side().querySelector('nav a[href="/dashboard/inbox"]')!.textContent).toContain('Couldn’t check');
    expect(side().querySelector('nav a[href="/dashboard/connect"]')!.textContent).toBe('Integrations');
  });

  it('marks the current page and keeps the same person on every page', () => {
    for (const [path, overview] of [['/dashboard', true], ['/dashboard/connect', false], ['/dashboard/settings', false], ['/dashboard/inbox', false]] as const) {
      nav.path = path;
      render(<DashboardFrame fullName="Ben Kraus" email="ben@nordwind.example" overview={overview} features={ALL_ON}><p>x</p></DashboardFrame>);
      expect(side().textContent, path).toContain('Ben Kraus');
      expect(within(side()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href')), path).toContain(path);
      cleanup();
    }
    nav.path = '/dashboard/connect';
  });

  it('shows the active organization and role when the session has one', () => {
    render(<DashboardFrame fullName="Ben Kraus" email="ben@nordwind.example" organizationName="Nordwind Spedition (test)" role="owner" features={ALL_ON}><p>x</p></DashboardFrame>);
    expect(screen.getByTestId('active-org').textContent).toBe('Nordwind Spedition (test) · Owner');
  });

  it('falls back to the email when the person has no display name', () => {
    render(<DashboardFrame fullName={null} email="clara@example.test" features={ALL_ON}><p>x</p></DashboardFrame>);
    expect(screen.getByRole('link', { name: 'Your account: clara@example.test' })).toBeTruthy();
  });
});
