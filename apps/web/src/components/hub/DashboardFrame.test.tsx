// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ path: '/dashboard/chat' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
vi.mock('@/i18n/provider', () => ({ useT: () => (k: string) => (k === 'hub.state.held' ? 'On hold pending review' : k) }));
import { DashboardFrame } from './DashboardFrame';

afterEach(cleanup);

describe('DashboardFrame', () => {
  it('shows the signed-in person and the TuGPT brand, not an organization block', () => {
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

  it('shows the same person on every dashboard page and never an organization or company name', () => {
    for (const [path, overview] of [['/dashboard', true], ['/dashboard/chat', false], ['/dashboard/create', false], ['/dashboard/connect', false], ['/dashboard/settings', false], ['/dashboard/inbox', false]] as const) {
      nav.path = path;
      render(<DashboardFrame fullName="Ben Kraus" email="ben@nordwind.example" overview={overview}><p>x</p></DashboardFrame>);
      const side = screen.getByLabelText('Dashboard navigation');
      expect(side.textContent, path).toContain('Ben Kraus');
      expect(side.textContent, path).toContain('ben@nordwind.example');
      expect(side.textContent, path).not.toMatch(/GmbH|organization|Hartmann|Nordwind Spedition|S\.L\.|Ltd|Inc\b/i);
      expect(screen.getByRole('link', { name: 'Your account: Ben Kraus' })).toBeTruthy();
      cleanup();
    }
    nav.path = '/dashboard/chat';
  });

  it('falls back to the email when the person has no display name', () => {
    render(<DashboardFrame fullName={null} email="clara@example.test"><p>x</p></DashboardFrame>);
    expect(screen.getByLabelText('Dashboard navigation').textContent).toContain('clara@example.test');
    expect(screen.getByRole('link', { name: 'Your account: clara@example.test' })).toBeTruthy();
  });
});
