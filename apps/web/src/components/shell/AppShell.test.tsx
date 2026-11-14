// @vitest-environment jsdom
/**
 * @file AppShell.test.tsx
 * @description The frame a reviewer sees on every dashboard page.
 *
 * Two of these assertions are the only thing standing behind claims made
 * elsewhere: `app-routes-reachable.test.ts` excuses `/auth/logout` from the
 * navigation on the grounds that this header links to it, and that excuse is
 * worth exactly as much as the test that checks it.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppShell } from './AppShell';
import { createTranslator } from '@/i18n';

const pathname = vi.hoisted(() => ({ value: '/dashboard/drafts' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
    [key: string]: unknown;
  }) => (
    // `data-prefetch` so a test can see a prop the DOM otherwise swallows.
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const t = createTranslator('en');

function renderShell(overrides: { organizationName?: string | null; email?: string | null } = {}) {
  return render(
    <AppShell
      organizationName={overrides.organizationName === undefined ? 'Panadería La Espiga' : overrides.organizationName}
      email={overrides.email === undefined ? 'revisor@example.com' : overrides.email}
      t={t}
    >
      <p>contenido de la página</p>
    </AppShell>
  );
}

afterEach(() => {
  pathname.value = '/dashboard/drafts';
  cleanup();
});

describe('what the header tells a reviewer', () => {
  it('names the organization whose replies are being approved', () => {
    // Multi-tenant product, and every draft on screen goes out as a business.
    // A reviewer who cannot see whose inbox this is can approve a bakery's
    // prices into a hardware store's conversation.
    renderShell();
    expect(screen.getByText('Panadería La Espiga')).toBeTruthy();
  });

  it('says so plainly when the organization cannot be resolved', () => {
    // Supabase unreachable, or a user in no organization. The header renders
    // either way — a blank where the name goes reads as "no organization",
    // which is a different and much more alarming claim.
    renderShell({ organizationName: null });
    expect(screen.getByText(t('shell.organizationUnknown'))).toBeTruthy();
  });

  it('shows who is signed in', () => {
    renderShell();
    expect(screen.getByText('revisor@example.com')).toBeTruthy();
  });

  it('omits the identity line rather than rendering an empty one', () => {
    const { container } = renderShell({ email: null });
    expect(container.textContent).not.toContain('revisor@example.com');
    expect(screen.getByRole('link', { name: 'Sign out ↗' })).toBeTruthy();
  });
});

describe('signing out', () => {
  it('is a control in the header, not a URL to remember', () => {
    // THE REGRESSION THIS GUARDS. Before 2026-08-31 `/auth/logout` worked
    // perfectly and was reachable only by typing it. app-routes-reachable
    // excuses that route from the navigation because of this link.
    renderShell();
    const signOut = screen.getByRole('link', { name: 'Sign out ↗' });
    expect(signOut.getAttribute('href')).toBe('/auth/logout');
  });

  it('is not speculatively fetched', () => {
    // Harmless today — the sign-out happens in a browser effect on that page,
    // which a prefetch does not run. It matters the day that becomes a route
    // handler or a server action, because then hovering the link would end
    // the session, and that change has no reason to come back here.
    renderShell();
    expect(
      screen.getByRole('link', { name: 'Sign out ↗' }).getAttribute('data-prefetch')
    ).toBe('false');
  });
});

describe('navigation', () => {
  it('marks the section the reviewer is in', () => {
    renderShell();
    const drafts = screen.getByRole('link', { name: 'AI Drafts' });
    expect(drafts.getAttribute('aria-current')).toBe('page');
  });

  it('keeps the section marked while a draft under it is open', () => {
    pathname.value = '/dashboard/drafts/11111111-1111-1111-1111-111111111111';
    renderShell();
    expect(screen.getByRole('link', { name: 'AI Drafts' }).getAttribute('aria-current')).toBe(
      'page'
    );
  });

  it('marks nothing when the reviewer is somewhere else entirely', () => {
    pathname.value = '/dashboard/somewhere-new';
    renderShell();
    expect(
      screen.getByRole('link', { name: 'AI Drafts' }).getAttribute('aria-current')
    ).toBeNull();
  });

  it('carries a label, so it is not just "navigation" to a screen reader', () => {
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Application modules' })).toBeTruthy();
  });
});

describe('the way back to the Dashboard hub', () => {
  it('links the product name to /dashboard from every tool page', () => {
    renderShell();
    const home = screen.getByRole('link', { name: 'TuGPT Dashboard' });
    expect(home.getAttribute('href')).toBe('/dashboard');
  });
});

describe('keyboard access', () => {
  it('offers a skip link that lands on the page content', () => {
    // Without it, every navigation costs a reviewer working by keyboard a tab
    // through the whole header before they reach the draft they came to read.
    const { container } = renderShell();
    const skip = screen.getByRole('link', { name: t('shell.skipToContent') });
    const target = skip.getAttribute('href')?.replace('#', '');

    expect(target).toBeTruthy();
    expect(container.querySelector(`#${target}`)?.tagName).toBe('MAIN');
  });

  it('puts the skip link first, where it can actually be reached', () => {
    const { container } = renderShell();
    const firstLink = container.querySelector('a');
    expect(firstLink?.textContent).toBe(t('shell.skipToContent'));
  });
});

describe('what the shell must never offer', () => {
  it('renders no send or WhatsApp control', () => {
    // Amendment 7 applies to the frame as much as to the draft screen: the
    // header is exactly where a "send" button would look natural.
    renderShell();
    expect(screen.queryByRole('button', { name: /send|enviar/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /send|enviar/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('renders the page it was given', () => {
    renderShell();
    expect(screen.getByText('contenido de la página')).toBeTruthy();
  });
});

describe('where the server/client boundary sits', () => {
  it('keeps AppShell on the server, because it takes a function prop', () => {
    // `t` is a function. Adding 'use client' here would compile, pass every
    // test in this file — jsdom does not enforce the boundary — and fail at
    // runtime on the deployed app with "Functions cannot be passed directly to
    // Client Components". The failure would appear on a page nobody had
    // touched, from a one-line change to a file that looks unrelated.
    const source = readFileSync(path.join(__dirname, 'AppShell.tsx'), 'utf8');
    expect(source).not.toMatch(/^\s*['"]use client['"]/m);
  });

  it('keeps PrimaryNav client-side and nav-items free of a client directive', () => {
    // These two file checks do not count every transitive client component.
    // The explicit organization switcher is intentional; AppShell remains
    // server-side. Build/runtime serialization validation is still required.
    const nav = readFileSync(path.join(__dirname, 'PrimaryNav.tsx'), 'utf8');
    expect(nav).toMatch(/^\s*['"]use client['"]/m);

    const items = readFileSync(path.join(__dirname, 'nav-items.ts'), 'utf8');
    expect(items).not.toMatch(/^\s*['"]use client['"]/m);
  });
});

it('keeps organization selection explicit and held modules non-operational', () => {
  const { container } = renderShell();
  expect(screen.getByRole('button', { name: 'Switch organization' })).toBeTruthy();
  expect(container.querySelector('a[href="/dashboard/media"]')).toBeNull();
  expect(container.querySelector('a[href="/settings/integrations"]')).toBeNull();
});
