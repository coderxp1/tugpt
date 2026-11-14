// @vitest-environment jsdom
// This legacy behavioral suite explicitly tests its original Spanish fixture copy.
/**
 * @file ConversationThread.test.tsx
 * @description The thread as a reviewer sees it.
 *
 * The route tests prove the response is right. These prove the screen does not
 * quietly throw the important parts of it away — the marked source message, and
 * the two things the thread has to admit to rather than render past.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationThread } from './ConversationThread';
import { createTranslator } from '@/i18n';

const t = createTranslator('es');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const SOURCE_ID = '11111111-1111-1111-1111-111111111111';

const thread = (overrides: Record<string, unknown> = {}) => ({
  thread: {
    conversation_id: '22222222-2222-2222-2222-222222222222',
    contact_display: '***-***-4567',
    status: 'open',
    messages: [
      {
        id: '00000000-0000-0000-0000-000000000000',
        body: '¿Tienen pan integral?',
        direction: 'inbound',
        created_at: '2026-09-01T10:00:00.000Z',
        is_source: false,
      },
      {
        id: SOURCE_ID,
        body: '¿Y tortas para el sábado?',
        direction: 'inbound',
        created_at: '2026-09-01T11:00:00.000Z',
        is_source: true,
      },
    ],
    has_more: false,
    source_in_window: true,
    ...overrides,
  },
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const err = (status: number, code: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message: 'nope' } }),
});

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

describe('reading the conversation', () => {
  it('T1: renders every message it was given', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText('¿Tienen pan integral?')).toBeTruthy();
    expect(screen.getByText('¿Y tortas para el sábado?')).toBeTruthy();
  });

  it('T2: keeps the order the API sent, which is oldest first', async () => {
    // The component must not re-sort. The API already decided reading order,
    // and a second opinion about it here is a second thing to get wrong.
    mockFetch.mockResolvedValueOnce(ok(thread()));
    const { container } = render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    const text = container.textContent ?? '';
    expect(text.indexOf('¿Tienen pan integral?')).toBeLessThan(
      text.indexOf('¿Y tortas para el sábado?')
    );
  });

  it('T3: marks the message the draft answers, in words and not only in colour', async () => {
    // A reviewer who cannot distinguish amber from white still has to find the
    // one message on this screen they came to find.
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.sourceLabel'))).toBeTruthy();
  });

  it('T4: distinguishes the customer from the business', async () => {
    mockFetch.mockResolvedValueOnce(
      ok(
        thread({
          messages: [
            { id: 'a', body: 'hola', direction: 'inbound', created_at: '2026-09-01T10:00:00.000Z', is_source: false },
            { id: 'b', body: 'buenas', direction: 'outbound', created_at: '2026-09-01T10:05:00.000Z', is_source: false },
          ],
        })
      )
    );
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.fromCustomer'))).toBeTruthy();
    expect(screen.getByText(t('drafts.thread.fromBusiness'))).toBeTruthy();
  });

  it('T5: renders a message with no text as a note, not as a blank row', async () => {
    // `messages.body` is nullable. A blank row reads as a rendering bug.
    mockFetch.mockResolvedValueOnce(
      ok(thread({ messages: [{ id: 'a', body: null, direction: 'inbound', created_at: '2026-09-01T10:00:00.000Z', is_source: false }] }))
    );
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.noBody'))).toBeTruthy();
  });
});

describe('what the thread admits to', () => {
  it('T6: says older messages exist rather than just stopping', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ has_more: true })));
    render(<ConversationThread draftId="d1" />);

    expect(
      await screen.findByText(t('drafts.thread.olderHidden', { count: '2' }))
    ).toBeTruthy();
  });

  it('T7: does not claim older messages exist when they do not', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ has_more: false })));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByText(/mensajes más recientes/)).toBeNull();
  });

  it('T8: says when the message being answered is outside the window', async () => {
    // Otherwise the reviewer reads a history that does not contain the message
    // the draft replies to, and nothing on screen says so.
    mockFetch.mockResolvedValueOnce(
      ok(thread({ source_in_window: false, messages: [{ id: 'a', body: 'hola', direction: 'inbound', created_at: '2026-09-01T10:00:00.000Z', is_source: false }] }))
    );
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.sourceOutOfWindow'))).toBeTruthy();
  });

  it('T9: stays quiet when the source is where it should be', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByText(t('drafts.thread.sourceOutOfWindow'))).toBeNull();
  });

  it('T10: explains an empty conversation instead of showing nothing', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ messages: [] })));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.empty'))).toBeTruthy();
  });
});

describe('when it cannot load', () => {
  it('T11: translates a known API error rather than echoing the English', async () => {
    mockFetch.mockResolvedValueOnce(err(403, 'FORBIDDEN'));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('errors.FORBIDDEN'))).toBeTruthy();
  });

  it('T12: Retry actually retries', async () => {
    // The regression the draft inbox shipped with for months: `setPage((p) => p)`
    // sets the same value, React bails out, and the effect the button exists to
    // re-run never re-runs. Asserted here rather than assumed not to recur.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(err(500, 'INTERNAL_ERROR'));
    render(<ConversationThread draftId="d1" />);

    const button = await screen.findByRole('button', { name: t('drafts.thread.retry') });
    const before = mockFetch.mock.calls.length;

    mockFetch.mockResolvedValueOnce(ok(thread()));
    await user.click(button);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('¿Tienen pan integral?')).toBeTruthy();
  });
});

describe('the handoff control', () => {
  /** The thread reload that follows every handoff attempt. */
  const andReload = (status = 'open') => mockFetch.mockResolvedValueOnce(ok(thread({ status })));

  async function clickHandoff(name: string) {
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name });
    await user.click(button);
    return button;
  }

  it('T15: offers to hand off an open conversation, and says what that does', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByRole('button', { name: t('thread.handoff') })).toBeTruthy();
    // Not yet handed off, so the screen must not claim the AI has stopped.
    expect(screen.queryByText(t('thread.handedOff'))).toBeNull();
  });

  it('T16: sends needsHuman true with the status the screen is showing', async () => {
    // `expectedStatus` is the compare-and-set. Sending anything other than what
    // was rendered would let this screen silently overwrite a colleague's
    // decision made thirty seconds ago.
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);

    mockFetch.mockResolvedValueOnce(ok({ conversation: {} }));
    andReload('needs_human');
    await clickHandoff(t('thread.handoff'));

    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/handoff'));
    expect(call, 'expected a POST to the handoff route').toBeTruthy();
    expect(call![0]).toBe('/api/v1/conversations/22222222-2222-2222-2222-222222222222/handoff');
    expect(call![1].method).toBe('POST');
    expect(JSON.parse(call![1].body)).toEqual({ needsHuman: true, expectedStatus: 'open' });
  });

  it('T17: a handed-off conversation says so and offers the opposite action', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'needs_human' })));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('thread.handedOff'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('thread.returnToAi') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('thread.handoff') })).toBeNull();
  });

  it('T18: returning to the AI sends needsHuman false, not the same value twice', async () => {
    // The direction is derived from the rendered status. A component that sent
    // `true` from both buttons would look correct on the way out and be a
    // no-op on the way back — the AI never restarts and nothing says why.
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'needs_human' })));
    render(<ConversationThread draftId="d1" />);

    mockFetch.mockResolvedValueOnce(ok({ conversation: {} }));
    andReload('open');
    await clickHandoff(t('thread.returnToAi'));

    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/handoff'));
    expect(JSON.parse(call![1].body)).toEqual({
      needsHuman: false,
      expectedStatus: 'needs_human',
    });
  });

  it('T19: a closed conversation offers neither direction', async () => {
    // The RPC refuses the transition (P3C05). Showing a button that can only
    // fail teaches a reviewer to ignore error messages.
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'closed' })));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByRole('button', { name: t('thread.handoff') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('thread.returnToAi') })).toBeNull();
  });

  it('T20: a refusal is shown in Spanish, not swallowed', async () => {
    // Silence here is the worst outcome: the reviewer believes the AI is off
    // for this customer and it is not.
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);

    mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
    andReload('needs_human');
    await clickHandoff(t('thread.handoff'));

    expect(await screen.findByText(t('errors.ASSIGNMENT_CONFLICT'))).toBeTruthy();
  });

  it('T21: re-reads the conversation afterwards, so the screen is not left stale', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);
    await screen.findByRole('button', { name: t('thread.handoff') });

    mockFetch.mockResolvedValueOnce(ok({ conversation: {} }));
    andReload('needs_human');
    await clickHandoff(t('thread.handoff'));

    // The reload is what turns the button around. Without it the screen still
    // offers "hand off" on a conversation already handed off, and the next
    // click sends a stale expectedStatus and is refused.
    expect(await screen.findByRole('button', { name: t('thread.returnToAi') })).toBeTruthy();
    expect(await screen.findByText(t('thread.handedOff'))).toBeTruthy();
  });

  it('T21b: a refusal survives a conversation someone else closed meanwhile', async () => {
    // The control is hidden on a closed conversation. If the refusal were
    // rendered inside that block it would vanish with the button, and the
    // reviewer would be left with a screen that says nothing about the action
    // they just took — T20's failure, one step further along.
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);

    mockFetch.mockResolvedValueOnce(err(422, 'INVALID_STATUS_TRANSITION'));
    andReload('closed');
    await clickHandoff(t('thread.handoff'));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(t('errors.INVALID_STATUS_TRANSITION'))).toBeTruthy();
  });

  it('T21c: a later successful handoff clears the earlier refusal', async () => {
    // A stale error about an action that then succeeded is worse than none:
    // the reviewer reads "that did not happen" about the thing that did, and
    // the thing in question is whether the AI is drafting to a customer.
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);

    mockFetch.mockResolvedValueOnce(err(409, 'ASSIGNMENT_CONFLICT'));
    andReload('open');
    await clickHandoff(t('thread.handoff'));
    await screen.findByText(t('errors.ASSIGNMENT_CONFLICT'));

    mockFetch.mockResolvedValueOnce(ok({ conversation: {} }));
    andReload('needs_human');
    await clickHandoff(t('thread.handoff'));

    await screen.findByRole('button', { name: t('thread.returnToAi') });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('T22: a network failure is reported rather than leaving the button dead', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ status: 'open' })));
    render(<ConversationThread draftId="d1" />);

    mockFetch.mockRejectedValueOnce(new Error('offline'));
    andReload('open');
    await clickHandoff(t('thread.handoff'));

    expect(await screen.findByText(t('thread.handoffFailed'))).toBeTruthy();
  });
});

describe('what the thread must never offer', () => {
  it('T13: renders no send or WhatsApp control', async () => {
    // Amendment 7, asserted here by name because this is the screen in the
    // product that most looks like a chat — which is exactly where a send box
    // would seem to belong.
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByRole('button', { name: /send|enviar|responder/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('T14: shows the masked contact and never a raw number', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread()));
    const { container } = render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.getByText('***-***-4567')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\+\d{7,}/);
  });
});

import { render } from '../../../tests/support/render-spanish';
