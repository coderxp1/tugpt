// @vitest-environment jsdom
// This legacy behavioral suite explicitly tests its original Spanish fixture copy.
/**
 * @file DraftInbox.test.tsx
 * @description The inbox had no tests at all until 2026-08-31, which is how
 * its Retry button spent months doing nothing.
 *
 * Two things here are load-bearing outside this file:
 *
 *   * `app-routes-reachable.test.ts` excuses `/dashboard/drafts/[draftId]`
 *     from the navigation because every row here links to one. That excuse is
 *     worth what the assertion below is worth.
 *   * Retry called `setPage((p) => p)` — the same value, so React bailed out
 *     and the effect never re-ran. It was fixed with the dictionaries; it is
 *     tested now, because the fix is invisible in a diff of strings and the
 *     next person to touch this effect deserves to be told.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DraftInbox } from './DraftInbox';
import { createTranslator } from '@/i18n';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const t = createTranslator('es');

const DRAFT_A = '11111111-1111-1111-1111-111111111111';
const DRAFT_B = '22222222-2222-2222-2222-222222222222';

const listPayload = (overrides: Record<string, unknown> = {}) => ({
  drafts: [
    {
      id: DRAFT_A,
      status: 'draft',
      version: 1,
      provider: 'langdock',
      model: 'gpt-5-mini',
      created_at: '2026-08-30T10:00:00Z',
      updated_at: '2026-08-30T10:00:00Z',
      reviewed_at: null,
      rejected_at: null,
      source_message_preview: '¿Tienen tortas para el sábado?',
      current_revision_body_preview: 'Con gusto le confirmo…',
    },
    {
      id: DRAFT_B,
      status: 'approved',
      version: 2,
      provider: 'langdock',
      model: 'gpt-5-mini',
      created_at: '2026-08-30T11:00:00Z',
      updated_at: '2026-08-30T11:00:00Z',
      reviewed_at: '2026-08-30T11:05:00Z',
      rejected_at: null,
      source_message_preview: '¿A qué hora abren?',
      current_revision_body_preview: 'Buenos días…',
    },
  ],
  total: 2,
  page: 1,
  limit: 20,
  ...overrides,
});

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message } }),
});

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(cleanup);

describe('getting from the inbox to a draft', () => {
  it('links every row to its own detail page', async () => {
    // The whole reason `/dashboard/drafts/[draftId]` is allowed to be absent
    // from the primary navigation.
    mockFetch.mockResolvedValueOnce(jsonOk(listPayload()));
    render(<DraftInbox />);

    const first = await screen.findByText('¿Tienen tortas para el sábado?');
    expect(first.closest('a')?.getAttribute('href')).toBe(`/dashboard/drafts/${DRAFT_A}`);

    const second = screen.getByText('¿A qué hora abren?');
    expect(second.closest('a')?.getAttribute('href')).toBe(`/dashboard/drafts/${DRAFT_B}`);
  });

  it('renders the status of each draft in Spanish, not the database enum', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk(listPayload()));
    render(<DraftInbox />);

    expect(await screen.findByText(t('drafts.status.draft'))).toBeTruthy();
    expect(screen.getByText(t('drafts.status.approved'))).toBeTruthy();
    // 'Draft' / 'Approved' reached the screen for months without existing in
    // the source, because the enum was capitalised at render time.
    expect(document.body.textContent).not.toContain('Approved');
  });
});

describe('Retry', () => {
  it('actually retries', async () => {
    // THE REGRESSION. `setPage((p) => p)` sets the same value, React bails
    // out, and the effect that Retry exists to re-run never re-runs. The
    // button looked fine and did nothing.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(jsonErr(500, 'INTERNAL_ERROR', 'boom'));
    render(<DraftInbox />);

    await screen.findByRole('button', { name: t('common.retry') });
    const callsBefore = mockFetch.mock.calls.length;

    mockFetch.mockResolvedValueOnce(jsonOk(listPayload()));
    await user.click(screen.getByRole('button', { name: t('common.retry') }));

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(await screen.findByText('¿Tienen tortas para el sábado?')).toBeTruthy();
  });
});

describe('states the reviewer can land in', () => {
  it('explains an empty inbox instead of showing nothing', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk(listPayload({ drafts: [], total: 0 })));
    render(<DraftInbox />);

    expect(await screen.findByText(t('drafts.inbox.empty'))).toBeTruthy();
  });

  it('translates a known API error code rather than echoing the English', async () => {
    mockFetch.mockResolvedValueOnce(jsonErr(403, 'FORBIDDEN', 'You do not have permission'));
    render(<DraftInbox />);

    expect(await screen.findByText(t('errors.FORBIDDEN'))).toBeTruthy();
  });

  it('says the feature is unavailable on 503, with no retry to bait a click', async () => {
    // 503 is the feature flag being off. Retrying cannot help, so the button
    // that implies it might is deliberately absent.
    mockFetch.mockResolvedValueOnce(jsonErr(503, 'FEATURE_UNAVAILABLE', 'unavailable'));
    render(<DraftInbox />);

    expect(await screen.findByText(t('drafts.detail.featureUnavailable'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('common.retry') })).toBeNull();
  });
});

describe('what the inbox must never offer', () => {
  it('renders no send or WhatsApp control', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk(listPayload()));
    render(<DraftInbox />);

    await screen.findByText('¿Tienen tortas para el sábado?');
    expect(screen.queryByRole('button', { name: /send|enviar/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });
});

import { render } from '../../../tests/support/render-spanish';
