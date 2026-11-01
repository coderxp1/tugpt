// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTranslator } from '@/i18n';
import { I18nProvider } from '@/i18n/provider';
import { resolveProducts } from '@/lib/hub/products';
import { UNAVAILABLE_SIGNALS, type HubSignals } from '@/lib/hub/signals';
import { ProductHub } from './ProductHub';

vi.mock('next/link', () => ({
  default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean; [k: string]: unknown }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const t = createTranslator('en');

const signals: HubSignals = {
  needsHuman: 2,
  openConversations: 9,
  draftsAwaitingReview: 0,
  knowledgeEntries: 14,
  activeMediaJobs: 0,
  whatsapp: 'none',
  calendar: 'connected',
};

function renderHub(s: HubSignals = signals) {
  return render(
    <I18nProvider locale="en">
      <ProductHub organizationName="Panadería La Espiga" email="owner@example.com" role="Owner" products={resolveProducts(s)} t={t} />
    </I18nProvider>
  );
}

afterEach(cleanup);

describe('the Dashboard hub', () => {
  it('names the active organization and the signed-in person', () => {
    renderHub();
    expect(screen.getAllByText('Panadería La Espiga').length).toBeGreaterThan(0);
    expect(screen.getByText('owner@example.com')).toBeTruthy();
  });

  it('opens every built product through a real link', () => {
    renderHub();
    const list = screen.getByRole('list', { name: t('hub.products.label') });
    const hrefs = within(list).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining(['/dashboard/inbox', '/dashboard/drafts', '/dashboard/knowledge', '/dashboard/media', '/settings/integrations', '/dashboard/analytics'])
    );
  });

  it('never links the Workspace, and says it is the next phase', () => {
    renderHub();
    const list = screen.getByRole('list', { name: t('hub.products.label') });
    const ws = within(list).getByRole('button', { name: new RegExp(t('hub.product.workspace')) });
    expect(ws.closest('a')).toBeNull();
    expect(within(ws).getByText(t('hub.state.planned'))).toBeTruthy();
  });

  it('puts what is waiting on a person at the top, with the real count', () => {
    renderHub();
    const waiting = screen.getByRole('link', { name: /Conversations · 2 need a person/ });
    expect(waiting.getAttribute('href')).toBe('/dashboard/inbox');
  });

  it('shows the inspector for the product being explored', () => {
    renderHub();
    const inspector = screen.getByRole('complementary', { name: t('hub.inspector.label') });
    // Starts on the product that needs attention.
    expect(within(inspector).getByRole('heading', { name: t('hub.product.conversations') })).toBeTruthy();
    fireEvent.focus(screen.getByRole('link', { name: new RegExp(`^${t('hub.product.knowledge')}`) }));
    expect(within(inspector).getByRole('heading', { name: t('hub.product.knowledge') })).toBeTruthy();
    expect(within(inspector).getByRole('link', { name: /Open Knowledge/ }).getAttribute('href')).toBe('/dashboard/knowledge');
  });

  it('admits when figures could not be read instead of showing zero', () => {
    renderHub(UNAVAILABLE_SIGNALS);
    expect(screen.getByText(new RegExp(t('hub.pulse.partial')))).toBeTruthy();
    expect(screen.getAllByText(t('hub.state.unknown')).length).toBeGreaterThan(0);
  });

  it('keeps sign-out a header control that is never prefetched', () => {
    renderHub();
    const out = screen.getByRole('link', { name: t('shell.signOut') });
    expect(out.getAttribute('href')).toBe('/auth/logout');
    expect(out.getAttribute('data-prefetch')).toBe('false');
  });
});
