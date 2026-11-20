// @vitest-environment jsdom
// This legacy behavioral suite explicitly tests its original Spanish fixture copy.
/**
 * @file DraftReviewUi.test.tsx
 * @description Behavioural tests for the human-review UI — the browser path a
 * real reviewer uses.
 *
 * REWRITTEN 2026-08-19. The previous version of this file had nine passing
 * tests and rendered nothing. They asserted `expect(DraftActions).toBeDefined()`
 * and re-read mocks they had just configured (`mockResolvedValueOnce({status:
 * 503})` followed by `expect(res.status).toBe(503)`, which tests vitest), with
 * comments saying the real behaviour was "verified by code inspection".
 *
 * Code inspection missed that clicking Edit opened an empty textarea, so a
 * reviewer had to retype the whole AI draft to change one word — in a product
 * whose entire premise is AI drafts plus human edit. The milestone-1 harness
 * could not catch it either: it calls edit_draft directly with a body and never
 * touches the UI.
 *
 * So these tests render the components and drive them the way a reviewer does.
 *
 * 2026-08-30: the UI renders Spanish (ADR-017), so the queries go through the
 * dictionary rather than through Spanish literals. What is worth asserting is
 * that a component reaches for the right KEY — a literal here would fail on
 * every copy edit while telling you nothing about whether the UI is wired up.
 * The components render without an I18nProvider and get the default Spanish
 * translator, which is the same one this file builds.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DraftDetail } from './DraftDetail';
import { DraftActions } from './DraftActions';
import { createTranslator } from '@/i18n';

const t = createTranslator('es');

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// The sub-histories issue their own fetches; they are not what these tests are
// about, so stub them to render nothing.
vi.mock('./DraftRevisionHistory', () => ({ DraftRevisionHistory: () => null }));
vi.mock('./DraftEventHistory', () => ({ DraftEventHistory: () => null }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_BODY = 'Hello! We are open until 6pm today. Would you like to book a slot?';

function draftPayload(overrides: Record<string, unknown> = {}) {
  return {
    draft: {
      id: DRAFT_ID,
      status: 'draft',
      version: 3,
      provider: 'langdock',
      model: 'gpt-5-mini',
      created_at: '2026-08-19T10:00:00Z',
      updated_at: '2026-08-19T10:00:00Z',
      current_revision_body: DRAFT_BODY,
      ...overrides,
    },
  };
}

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message } }),
});

const textareaValue = (): string => (screen.getByRole('textbox') as HTMLTextAreaElement).value;

/** Render DraftDetail and wait for its initial load to settle. */
async function renderDetail(payload = draftPayload()) {
  mockFetch.mockResolvedValueOnce(jsonOk(payload));
  render(<DraftDetail draftId={DRAFT_ID} />);
  await screen.findByText(t('drafts.detail.title'));
}

/** The JSON body of the request sent to a given endpoint suffix. */
function requestBodyFor(suffix: string): Record<string, unknown> {
  const call = mockFetch.mock.calls.find((c) => String(c[0]).endsWith(suffix));
  if (!call) throw new Error(`no request to ${suffix}`);
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('editing a draft', () => {
  it('pre-fills the editor with the current draft body', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before 2026-08-19 the textarea
    // opened empty, so a one-word correction meant retyping the whole draft.
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));

    expect(textareaValue()).toBe(DRAFT_BODY);
  });

  it('sends the edited body and the current version', async () => {
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Rewritten by the reviewer.');

    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { version: 4 } }));
    mockFetch.mockResolvedValueOnce(jsonOk(draftPayload({ version: 4 })));
    await user.click(screen.getByRole('button', { name: t('drafts.actions.save') }));

    await waitFor(() =>
      expect(requestBodyFor('/edit')).toEqual({
        expectedLockVersion: 3,
        body: 'Rewritten by the reviewer.',
      })
    );
  });

  it('refuses to submit an empty body without calling the API', async () => {
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));
    await user.clear(screen.getByRole('textbox'));

    const callsBefore = mockFetch.mock.calls.length;
    await user.click(screen.getByRole('button', { name: t('drafts.actions.save') }));

    expect(await screen.findByText(t('drafts.actions.emptyBody'))).toBeTruthy();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('discards changes on cancel, and reopens from the current body again', async () => {
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'scratch');
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));
    expect(textareaValue()).toBe(DRAFT_BODY);
  });
});

describe('approving and rejecting', () => {
  it('approve posts the current version to the approve endpoint', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { status: 'approved' } }));
    mockFetch.mockResolvedValueOnce(jsonOk(draftPayload({ status: 'approved', version: 4 })));
    await user.click(screen.getByRole('button', { name: t('drafts.actions.approve') }));

    await waitFor(() => expect(requestBodyFor('/approve')).toEqual({ expectedLockVersion: 3 }));
  });

  it('reject posts the current version to the reject endpoint', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { status: 'rejected' } }));
    mockFetch.mockResolvedValueOnce(jsonOk(draftPayload({ status: 'rejected', version: 4 })));
    await user.click(screen.getByRole('button', { name: t('drafts.actions.reject') }));

    await waitFor(() => expect(requestBodyFor('/reject')).toEqual({ expectedLockVersion: 3 }));
  });

  it('shows the stale-version banner on 409, with a reload action', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonErr(409, 'STALE_VERSION', 'stale'));
    await user.click(screen.getByRole('button', { name: t('drafts.actions.approve') }));

    expect(await screen.findByText(t('drafts.detail.stale'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('common.reload') })).toBeTruthy();
  });

  it('shows a permission message on 403 rather than a generic error', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonErr(403, 'FORBIDDEN', 'forbidden'));
    await user.click(screen.getByRole('button', { name: t('drafts.actions.approve') }));

    expect(await screen.findByText(t('drafts.actions.permissionDenied'))).toBeTruthy();
  });

  it('translates a known API error code rather than echoing the English', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(
      jsonErr(422, 'INVALID_STATE_TRANSITION', 'This draft cannot be modified in its current state')
    );
    await user.click(screen.getByRole('button', { name: t('drafts.actions.approve') }));

    expect(await screen.findByText(t('errors.INVALID_STATE_TRANSITION'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('cannot be modified');
  });

  it('falls back to the server sentence for a code it has no translation for', async () => {
    // The failure this prevents is a reviewer seeing `P3B0…` or a blank box
    // the first time a new SQLSTATE is mapped server-side. English is a worse
    // answer than Spanish and a much better one than an identifier.
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(
      jsonErr(422, 'SOMETHING_MAPPED_LATER', 'The server explained itself in English')
    );
    await user.click(screen.getByRole('button', { name: t('drafts.actions.approve') }));

    expect(
      await screen.findByText('The server explained itself in English')
    ).toBeTruthy();
  });
});

describe('the version a second action uses', () => {
  it('does not leave an action button live on the pre-edit version', async () => {
    // After an edit the draft is on version 4, but the parent refetch is
    // asynchronous. If the buttons stayed live during that window, an
    // immediate Approve would send version 3 and come back 409 "modified by
    // another reviewer" — blaming a second reviewer for the first one's own
    // edit, which is the most confusing message the UI could produce.
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));

    let resolveRefetch: (value: unknown) => void = () => {};
    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { version: 4 } }));
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      })
    );

    await user.click(screen.getByRole('button', { name: t('drafts.actions.save') }));

    await waitFor(() => expect(screen.queryByRole('button', { name: t('drafts.actions.approve') })).toBeNull());

    resolveRefetch(jsonOk(draftPayload({ version: 4 })));
    await screen.findByRole('button', { name: t('drafts.actions.approve') });
  });
});

describe('what the UI must never offer', () => {
  it('renders no Send or WhatsApp control on a reviewable draft', async () => {
    // Outbound customer messaging does not exist yet and requires explicit
    // owner approval. A real DOM assertion, not a comment.
    await renderDetail();

    // /enviar/ as well as /send/: this guard was written against an English
    // UI, and a Spanish "Enviar" button would have sailed straight through it.
    expect(screen.queryByRole('button', { name: /send|enviar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /whatsapp/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('renders no action buttons at all for an approved draft', async () => {
    await renderDetail(draftPayload({ status: 'approved' }));

    expect(screen.queryByRole('button', { name: t('drafts.actions.approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('drafts.actions.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('drafts.actions.reject') })).toBeNull();
    expect(screen.getByText(t('drafts.status.approved'))).toBeTruthy();
  });

  it('renders no action buttons at all for a rejected draft', async () => {
    await renderDetail(draftPayload({ status: 'rejected' }));

    expect(screen.queryByRole('button', { name: t('drafts.actions.approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('drafts.actions.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('drafts.actions.reject') })).toBeNull();
    expect(screen.getByText(t('drafts.status.rejected'))).toBeTruthy();
  });
});

describe('states the reviewer can land in', () => {
  it('explains that the feature is unavailable on 503', async () => {
    mockFetch.mockResolvedValueOnce(jsonErr(503, 'FEATURE_UNAVAILABLE', 'unavailable'));
    render(<DraftDetail draftId={DRAFT_ID} />);

    expect(
      await screen.findByText(t('drafts.detail.featureUnavailable'))
    ).toBeTruthy();
  });

  it('offers a way back to the inbox when the draft is not found', async () => {
    mockFetch.mockResolvedValueOnce(jsonErr(404, 'DRAFT_NOT_FOUND', 'nope'));
    render(<DraftDetail draftId={DRAFT_ID} />);

    expect(await screen.findByText(t('drafts.detail.notFound'))).toBeTruthy();
    expect(screen.getByText(t('drafts.detail.backToInbox'))).toBeTruthy();
  });

  it('shows the draft body and its model attribution', async () => {
    await renderDetail();

    expect(screen.getByText(DRAFT_BODY)).toBeTruthy();
    expect(screen.getByText(t('drafts.detail.provider', { provider: 'langdock' }))).toBeTruthy();
    expect(screen.getByText(t('drafts.detail.model', { model: 'gpt-5-mini' }))).toBeTruthy();
  });
});

describe('DraftActions in isolation', () => {
  it('starts the editor from the body it is given', async () => {
    const user = userEvent.setup();
    render(
      <DraftActions
        draftId={DRAFT_ID}
        version={2}
        currentBody="the body under review"
        onActionComplete={() => {}}
        onStaleVersion={() => {}}
      />
    );

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));
    expect(textareaValue()).toBe('the body under review');
  });

  it('tolerates a draft with no readable body', async () => {
    const user = userEvent.setup();
    render(
      <DraftActions
        draftId={DRAFT_ID}
        version={2}
        currentBody={null}
        onActionComplete={() => {}}
        onStaleVersion={() => {}}
      />
    );

    await user.click(screen.getByRole('button', { name: t('drafts.actions.edit') }));
    expect(textareaValue()).toBe('');
  });
});

import { render } from '../../../tests/support/render-spanish';

// F-M9-4 (Agent 1: 1 failure in the full parallel web suite, 0 in isolation). The default 1 s async-util
// timeout of findBy*/waitFor is what ran out when the machine was busy (reproduced: 1 of 10 runs failed with
// 24 CPU burners on 12 cores). Waiting longer changes nothing about what is asserted: a query that can never
// succeed still fails, only later. testTimeout is raised so the larger wait cannot hit vitest's 5 s per-test limit.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// Every mutation emitted by the retained behavioral cases must satisfy the browser contract.
afterEach(() => {
  for (const [, init] of mockFetch.mock.calls) {
    const options = init as RequestInit | undefined;
    if (!options?.method || ['GET', 'HEAD'].includes(options.method)) continue;
    const headers = new Headers(options.headers);
    expect(headers.get('x-tugpt-csrf')).toBe('1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(() => JSON.parse(options.body as string)).not.toThrow();
  }
});
