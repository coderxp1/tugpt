// @vitest-environment jsdom
// This legacy behavioral suite explicitly tests its original Spanish fixture copy.
/**
 * @file ConversationInbox.test.tsx
 * @description The inbox as a reviewer sees it.
 *
 * The route tests prove the page of data is right. These prove the screen does
 * not throw away the parts that make it an inbox: which rows have work waiting,
 * where a row goes, and a Next button that means "the page after this one"
 * rather than "the page after however many I have counted".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationInbox } from './ConversationInbox';
import { createTranslator } from '@/i18n';

const t = createTranslator('es');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const CONV_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const CONV_B = 'bbbbbbbb-1111-1111-1111-111111111111';
const VIEWER = '99999999-9999-9999-9999-999999999999';
const COLLEAGUE = 'dddddddd-9999-9999-9999-999999999999';

const page = (overrides: Record<string, unknown> = {}) => ({
  conversations: [
    {
      id: CONV_A,
      contact_display: '***-***-4567',
      status: 'open',
      activity_at: '2026-09-01T11:00:00.000Z',
      awaiting_draft_id: 'draft-a',
      assigned_to: null,
    },
    {
      id: CONV_B,
      contact_display: '***-***-8901',
      status: 'closed',
      activity_at: '2026-09-01T10:00:00.000Z',
      awaiting_draft_id: null,
      assigned_to: null,
    },
  ],
  next_cursor: null,
  ...overrides,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const err = (status: number, code: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message: 'nope' } }),
});

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

const lastUrl = () => mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;

describe('reading the inbox', () => {
  it('T1: lists the conversations it was given', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText('***-***-4567')).toBeTruthy();
    expect(screen.getByText('***-***-8901')).toBeTruthy();
  });

  it('T2: keeps the order the API sent', async () => {
    // The API decided "most recently active first". A second opinion here is a
    // second thing to get wrong, and the component has no cursor to re-sort by.
    mockFetch.mockResolvedValueOnce(ok(page()));
    const { container } = render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-4567');
    const text = container.textContent ?? '';
    expect(text.indexOf('***-***-4567')).toBeLessThan(text.indexOf('***-***-8901'));
  });

  it('T3: marks the rows with a draft waiting, in words', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    const marks = await screen.findAllByText(t('inbox.awaitingReview'));
    expect(marks).toHaveLength(1);
  });

  it('T4: opens the draft that is waiting', async () => {
    // The row's whole purpose. A row that says "draft awaiting review" and
    // goes nowhere is the defect this replaced a boolean to avoid.
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toBe('/dashboard/drafts/draft-a');
  });

  it('T5: does not link a conversation with nothing to review', async () => {
    // There is no conversation detail page yet. A link to one would 404 while
    // looking exactly like the rest of the product.
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-8901');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    for (const link of links) {
      expect(link.getAttribute('href')).not.toContain(CONV_B);
    }
  });

  it('T6: names a contact it does not know rather than rendering a blank', async () => {
    mockFetch.mockResolvedValueOnce(
      ok(page({ conversations: [{ id: CONV_A, contact_display: null, status: 'open', activity_at: '2026-09-01T11:00:00.000Z', awaiting_draft_id: null, assigned_to: null }] }))
    );
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText(t('inbox.unknownContact'))).toBeTruthy();
  });

  it('T7: shows the conversation status in Spanish', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText(t('drafts.conversation.open'))).toBeTruthy();
    expect(screen.getByText(t('drafts.conversation.closed'))).toBeTruthy();
  });

  it('T8: explains an empty inbox', async () => {
    mockFetch.mockResolvedValueOnce(ok(page({ conversations: [] })));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText(t('inbox.empty'))).toBeTruthy();
  });

  it('T9: says an empty *filter* differently from an empty inbox', async () => {
    // "No conversations yet" under a filter is a lie that reads as an outage.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ conversations: [] })));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.closed') }));

    expect(await screen.findByText(t('inbox.emptyFiltered'))).toBeTruthy();
    expect(screen.queryByText(t('inbox.empty'))).toBeNull();
  });
});

describe('filtering', () => {
  it('T10: asks the API for the chosen status', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page()));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.needs_human') }));

    await waitFor(() => expect(lastUrl()).toContain('status=needs_human'));
  });

  it('T11: sends no status at all for "all"', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-4567');
    expect(lastUrl()).not.toContain('status=');
  });

  it('T12: marks the active filter for assistive technology, not only in colour', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    expect(screen.getByRole('button', { name: t('inbox.filter.all') }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: t('inbox.filter.open') }).getAttribute('aria-pressed')).toBe('false');
  });

  it('T13: drops the cursor when the filter changes', async () => {
    // A cursor names a position in one ordering of one filter. Carried across a
    // filter change it resumes in the middle of a list the reviewer has not
    // seen the start of — with no way to tell that is what happened.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR2' })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));
    await waitFor(() => expect(lastUrl()).toContain('cursor=CURSOR1'));

    mockFetch.mockResolvedValueOnce(ok(page()));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.open') }));

    await waitFor(() => expect(lastUrl()).toContain('status=open'));
    expect(lastUrl()).not.toContain('cursor=');
  });
});

describe('paging', () => {
  it('T14: offers Next only when the API says there is more', async () => {
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: t('inbox.next') })).toBeNull();
  });

  it('T15: Next sends the cursor the API gave it', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));

    await waitFor(() => expect(lastUrl()).toContain('cursor=CURSOR1'));
  });

  it('T16: offers a way back once the reviewer has paged', async () => {
    // A keyset cursor cannot be reversed. Without this the only way back to the
    // top of the inbox is reloading the page.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: t('inbox.start') })).toBeNull();

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));

    expect(await screen.findByRole('button', { name: t('inbox.start') })).toBeTruthy();
  });

  it('T17: going back to the start sends no cursor', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));
    await screen.findByRole('button', { name: t('inbox.start') });

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    await user.click(screen.getByRole('button', { name: t('inbox.start') }));

    await waitFor(() => expect(lastUrl()).not.toContain('cursor='));
  });
});

describe('when it cannot load', () => {
  it('T18: translates a known API error rather than echoing the English', async () => {
    mockFetch.mockResolvedValueOnce(err(403, 'FORBIDDEN'));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText(t('errors.FORBIDDEN'))).toBeTruthy();
  });

  it('T19: Retry actually retries', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(err(500, 'INTERNAL_ERROR'));
    render(<ConversationInbox viewerId={VIEWER} />);

    const button = await screen.findByRole('button', { name: t('inbox.retry') });
    const before = mockFetch.mock.calls.length;

    mockFetch.mockResolvedValueOnce(ok(page()));
    await user.click(button);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('***-***-4567')).toBeTruthy();
  });
});

describe('what the inbox must never offer', () => {
  it('T20: renders no send or WhatsApp control', async () => {
    // Amendment 7. Nothing in TuGPT sends.
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: /send|enviar|responder/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('T21: shows no raw phone number and no message text', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    const { container } = render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-4567');
    expect(container.textContent).not.toMatch(/\+\d{7,}/);
  });

  it('T22: shows each row exactly once', async () => {
    // The keyset cursor exists so a reordering list cannot repeat or skip a
    // row at a page boundary; a component that renders the page twice would
    // undo that where it is most visible.
    mockFetch.mockResolvedValueOnce(ok(page()));
    const { container } = render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText('***-***-4567');
    const list = container.querySelector('ul');
    expect(within(list as HTMLElement).getAllByText('***-***-4567')).toHaveLength(1);
  });
});


describe('assignment', () => {
  const assigned = (to: { id: string; display: string } | null) =>
    page({
      conversations: [
        {
          id: CONV_A,
          contact_display: '***-***-4567',
          status: 'open',
          activity_at: '2026-09-01T11:00:00.000Z',
          awaiting_draft_id: null,
          assigned_to: to,
        },
      ],
    });

  it('T23: says who has a conversation', async () => {
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: COLLEAGUE, display: 'Ana Reviewer' })));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText(t('inbox.assignedTo', { name: 'Ana Reviewer' }))).toBeTruthy();
  });

  it('T24: says when it is yours, in the second person', async () => {
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: VIEWER, display: 'You' })));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByText(t('inbox.assignedToYou'))).toBeTruthy();
  });

  it('T25: offers Claim on an unclaimed conversation', async () => {
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByRole('button', { name: t('inbox.claim') })).toBeTruthy();
  });

  it('T26: offers Release on your own, not Claim', async () => {
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: VIEWER, display: 'You' })));
    render(<ConversationInbox viewerId={VIEWER} />);

    expect(await screen.findByRole('button', { name: t('inbox.release') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('inbox.claim') })).toBeNull();
  });

  it('T27: offers nothing on a colleague-owned conversation', async () => {
    // Taking a conversation off somebody else is a different decision from
    // picking up an unclaimed one, and this screen does not offer it.
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: COLLEAGUE, display: 'Ana Reviewer' })));
    render(<ConversationInbox viewerId={VIEWER} />);

    await screen.findByText(t('inbox.assignedTo', { name: 'Ana Reviewer' }));
    expect(screen.queryByRole('button', { name: t('inbox.claim') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('inbox.release') })).toBeNull();
  });

  it('T28: claiming sends the assignee and what the screen was showing', async () => {
    // `expectedAssignee` is the compare-and-set. Sending the wrong thing here
    // is how two reviewers both silently win the same conversation.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockResolvedValueOnce(ok(assigned({ id: VIEWER, display: 'You' })));
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: VIEWER, display: 'You' })));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(1));
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe(`/api/v1/conversations/${CONV_A}/assign`);
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      assignee: VIEWER,
      expectedAssignee: null,
    });
  });

  it('T29: releasing sends null, and says what it expected to find', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: VIEWER, display: 'You' })));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    await user.click(await screen.findByRole('button', { name: t('inbox.release') }));

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(1));
    expect(JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body)).toEqual({
      assignee: null,
      expectedAssignee: VIEWER,
    });
  });

  it('T30: a refused claim is shown, not swallowed', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: COLLEAGUE, display: 'Ana Reviewer' })));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));

    expect(await screen.findByText(t('errors.ASSIGNMENT_CONFLICT'))).toBeTruthy();
  });

  it('T30b: survives the reload the claim itself triggers', async () => {
    // The bug this catches: the refusal was written into the same state the
    // load effect clears on success, so the message appeared and was wiped
    // milliseconds later by the reload. The reviewer saw a flicker and a
    // conversation that was not theirs, with nothing saying why.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: COLLEAGUE, display: 'Ana Reviewer' })));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));

    // Wait for the reload to land — the colleague's name is proof it did.
    await screen.findByText(t('inbox.assignedTo', { name: 'Ana Reviewer' }));
    expect(screen.getByText(t('errors.ASSIGNMENT_CONFLICT'))).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('T30c: a refusal does not take the list away', async () => {
    // `error` hides the whole inbox and offers Retry. Routing a refused claim
    // through it replaced the list with an error panel — losing the one thing
    // the reviewer needs in order to see who actually holds the conversation.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: COLLEAGUE, display: 'Ana Reviewer' })));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));

    await screen.findByText(t('errors.ASSIGNMENT_CONFLICT'));
    expect(screen.getByText('***-***-4567'), 'the list must still be there').toBeTruthy();
    expect(screen.queryByRole('button', { name: t('inbox.retry') })).toBeNull();
  });

  it('T30d: a network failure names the claim, not the list load', async () => {
    // Reusing `inbox.loadFailed` here told the reviewer the conversations
    // could not be loaded, while they are visibly on screen.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockRejectedValueOnce(new Error('offline'));
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));

    expect(await screen.findByText(t('inbox.claimFailed'))).toBeTruthy();
    expect(screen.queryByText(t('inbox.loadFailed'))).toBeNull();
  });

  it('T30e: a later successful claim clears the earlier refusal', async () => {
    // Otherwise the message outlives what it describes: the reviewer claims a
    // conversation, it works, the row updates — and the screen still says the
    // claim was refused. A stale error about a succeeded action is worse than
    // none, because it is the one the reviewer will believe.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);

    mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));
    await screen.findByText(t('errors.ASSIGNMENT_CONFLICT'));

    mockFetch.mockResolvedValueOnce(ok({ conversation: {} }));
    mockFetch.mockResolvedValueOnce(ok(assigned({ id: VIEWER, display: 'You' })));
    await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));

    await screen.findByText(t('inbox.assignedToYou'));
    expect(screen.queryByText(t('errors.ASSIGNMENT_CONFLICT'))).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('T30f: either filter row clears a refusal that no longer describes the list', async () => {
    // Both chip rows load a different list. A refusal about a row that may not
    // even be in the new one is left pointing at nothing.
    //
    // The two rows are separate callbacks, so both are exercised: clearing in
    // one and forgetting the other is exactly the kind of asymmetry that
    // survives a single-path test.
    const rows: Array<() => HTMLElement> = [
      () => within(screen.getByRole('group', { name: t('inbox.filterByStatus') })).getByRole('button', { name: t('inbox.filter.open') }),
      () => within(screen.getByRole('group', { name: t('inbox.filterByAssignee') })).getByRole('button', { name: t('inbox.filter.unassigned') }),
    ];

    for (const chip of rows) {
      cleanup();
      mockFetch.mockReset();
      const user = userEvent.setup();
      mockFetch.mockResolvedValueOnce(ok(assigned(null)));
      render(<ConversationInbox viewerId={VIEWER} />);

      mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
      mockFetch.mockResolvedValueOnce(ok(assigned(null)));
      await user.click(await screen.findByRole('button', { name: t('inbox.claim') }));
      await screen.findByText(t('errors.ASSIGNMENT_CONFLICT'));

      mockFetch.mockResolvedValueOnce(ok(assigned(null)));
      await user.click(chip());

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    }
  });

  it('T31: filters to the unassigned queue', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.unassigned') }));

    await waitFor(() => expect(lastUrl()).toContain('assignment=unassigned'));
  });

  it('T32: filters to mine without naming who that is', async () => {
    // The reviewer comes from the session on the server. If this ever put an
    // id in the query string, a caller could read a colleague's queue.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={VIEWER} />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.mine') }));

    await waitFor(() => expect(lastUrl()).toContain('assignment=mine'));
    expect(lastUrl()).not.toContain(VIEWER);
  });

  it('T33: a signed-out render offers no claim control at all', async () => {
    mockFetch.mockResolvedValueOnce(ok(assigned(null)));
    render(<ConversationInbox viewerId={null} />);

    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: t('inbox.claim') })).toBeNull();
  });
});

import { render } from '../../../tests/support/render-spanish';

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
