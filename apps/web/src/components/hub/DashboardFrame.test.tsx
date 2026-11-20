// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ path: '/dashboard/create' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
vi.mock('@/i18n/provider', () => ({ useT: () => (k: string) => (k === 'hub.state.held' ? 'On hold pending review' : k) }));
import { DashboardFrame } from './DashboardFrame';

afterEach(cleanup);

describe('DashboardFrame', () => {
  it('shows the signed-in person and the TuGPT brand; no organization line without one', () => {
    render(<DashboardFrame fullName="Anna Berger" email="anna@example.test"><p>x</p></DashboardFrame>);
    const nav = screen.getByLabelText('Dashboard navigation');
    expect(nav.textContent).toContain('Anna Berger');
    expect(nav.textContent).toContain('anna@example.test');
    expect(screen.getByRole('link', { name: 'TuGPT Dashboard' }).textContent).toContain('tugpt');
    expect(nav.textContent).not.toMatch(/organization|GmbH/i);
  });

  it('separates a held module title from its state for assistive tech and copy (no "Media StudioOn hold")', () => {
    render(<DashboardFrame email="anna@example.test"><p>x</p></DashboardFrame>);
    const nav = screen.getByLabelText('Application modules');
    expect(nav.textContent).not.toContain('Media StudioOn hold');
    expect(nav.textContent).toContain('Media Studio, On hold pending review');
  });

  it('shows the active organization and role when the session has one, and only that one', () => {
    render(<DashboardFrame fullName="Ben Kraus" email="ben@nordwind.example" organizationName="Nordwind Spedition (test)" role="owner"><p>x</p></DashboardFrame>);
    expect(screen.getByTestId('active-org').textContent).toBe('Nordwind Spedition (test) · Owner');
    expect(screen.getByLabelText('Dashboard navigation').textContent).not.toMatch(/Hartmann/);
  });

  it('labels each module with the organization feature state and keeps held and planned modules unclickable', () => {
    render(<DashboardFrame email="anna@example.test" features={{ inbox: 'disabled', drafts: 'available', analytics: 'partial', media: 'disabled' }}><p>x</p></DashboardFrame>);
    const mods = screen.getByLabelText('Application modules');
    expect(mods.querySelector('a[href="/dashboard/inbox"]')?.textContent).toContain('Not enabled');
    expect(mods.querySelector('a[href="/dashboard/drafts"]')?.textContent).toBe('AI Drafts');
    expect(mods.querySelector('a[href="/dashboard/analytics"]')?.textContent).toContain('Partly available');
    expect(mods.querySelector('a[href="/dashboard/media"]')).toBeNull();
    expect(mods.querySelector('a[href="/dashboard/agents"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/dashboard/settings');
  });

  it('shows the same person on every dashboard page and no company name unless the session gives one', () => {
    for (const [path, overview] of [['/dashboard', true], ['/dashboard/create', false], ['/dashboard/connect', false], ['/dashboard/settings', false], ['/dashboard/inbox', false]] as const) {
      nav.path = path;
      render(<DashboardFrame fullName="Ben Kraus" email="ben@nordwind.example" overview={overview}><p>x</p></DashboardFrame>);
      const side = screen.getByLabelText('Dashboard navigation');
      expect(side.textContent, path).toContain('Ben Kraus');
      expect(side.textContent, path).toContain('ben@nordwind.example');
      expect(side.textContent, path).not.toMatch(/GmbH|organization|Hartmann|Nordwind Spedition|S\.L\.|Ltd|Inc\b/i);
      expect(screen.getByRole('link', { name: 'Your account: Ben Kraus' })).toBeTruthy();
      cleanup();
    }
    nav.path = '/dashboard/create';
  });

  it('links to the Workspace from the sidebar and the top bar (chat moved to /workspace)', () => {
    render(<DashboardFrame email="anna@example.test"><p>x</p></DashboardFrame>);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs.filter((h) => h === '/workspace').length).toBeGreaterThanOrEqual(2);
    expect(hrefs).not.toContain('/dashboard/chat');
    expect(screen.getByRole('link', { name: 'dashboard.openWorkspace' }).getAttribute('href')).toBe('/workspace');
  });

  it('falls back to the email when the person has no display name', () => {
    render(<DashboardFrame fullName={null} email="clara@example.test"><p>x</p></DashboardFrame>);
    expect(screen.getByLabelText('Dashboard navigation').textContent).toContain('clara@example.test');
    expect(screen.getByRole('link', { name: 'Your account: clara@example.test' })).toBeTruthy();
  });
  it('tags Create with the real image-generation state and leaves it untagged when available', () => {
    const { unmount } = render(<DashboardFrame fullName="Anna" email="anna@example.test" features={{ images: 'disabled' }}><p>x</p></DashboardFrame>);
    const create = screen.getByRole('link', { name: /^Create/ });
    expect(create.textContent).toContain('Not enabled');
    expect(create.getAttribute('data-state')).toBe('disabled');
    unmount();
    render(<DashboardFrame fullName="Anna" email="anna@example.test" features={{ images: 'available' }}><p>x</p></DashboardFrame>);
    expect(screen.getByRole('link', { name: /^Create/ }).textContent).toBe('Create');
  });
});
