// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/chat' }));
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
});
