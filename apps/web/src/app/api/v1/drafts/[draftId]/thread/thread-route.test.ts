/**
 * @file thread-route.test.ts
 * @description GET /api/v1/drafts/:draftId/thread — the Sep 18 milestone.
 *
 * Three groups, in descending order of how much a silent failure would cost:
 *
 *   1. **What crosses the wire.** This route returns more customer text than
 *      anything else in the product. The assertions walk the *serialised
 *      response*, not the code, because the defect it was written against was
 *      exactly a field that existed in the payload and nowhere in the UI.
 *   2. **What the reviewer is shown.** Reading order, the marked source
 *      message, and the two conditions the thread has to admit to rather than
 *      render past — older messages hidden, source outside the window.
 *   3. **Scoping and bounds.** Conversation, organization, and a limit that
 *      cannot be talked out of by a query string.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GET as threadGET } from './route';

// --- Supabase harness -------------------------------------------------------
//
// Self-contained rather than shared with `drafts-routes.test.ts`: this is the
// only route whose query ends in `.limit()`, and teaching the shared chainable
// mock a new terminal method would change the object seven other routes are
// tested against.

interface TableResults {
  single?: { data: unknown; error: unknown };
  limit?: { data: unknown; error: unknown };
}

const tables: Record<string, TableResults> = {};
/** Every `.eq(column, value)` seen, per table — how scoping is asserted. */
const eqCalls: Record<string, Array<[string, unknown]>> = {};
/** Every `.order(column, opts)` seen, per table. */
const orderCalls: Record<string, Array<[string, unknown]>> = {};
/** The last `.limit(n)` seen, per table. */
const limitCalls: Record<string, number[]> = {};

const mockFrom = vi.fn((table: string) => {
  eqCalls[table] ??= [];
  orderCalls[table] ??= [];
  limitCalls[table] ??= [];

  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn((col: string, val: unknown) => {
    eqCalls[table].push([col, val]);
    return chain;
  });
  chain.order = vi.fn((col: string, opts: unknown) => {
    orderCalls[table].push([col, opts]);
    return chain;
  });
  chain.limit = vi.fn((n: number) => {
    limitCalls[table].push(n);
    return Promise.resolve(tables[table]?.limit ?? { data: [], error: null });
  });
  chain.single = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(tables[table]?.single ?? { data: null, error: { code: 'PGRST116' } })
    );
  return chain;
});

const mockFeatureRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createFeatureServerClient: vi.fn(async () => ({ rpc: mockFeatureRpc })),
  createAuthenticatedServerClient: vi.fn(() => Promise.resolve({ from: mockFrom, rpc: vi.fn() })),
}));

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => { throw new Error('Privileged transport forbidden'); }),
}));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: mockGetCurrentUser,
      resolveTenantContext: mockResolveTenantContext,
    };
  }),
}));

// --- Fixtures ---------------------------------------------------------------

const DRAFT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const CONVERSATION_ID = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SOURCE_MESSAGE_ID = 'c1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ORG_ID = 'org-1';

/** Newest first — the order the query returns them in. */
function messageRows(count: number, opts: { includeSource?: boolean } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: i === 0 && opts.includeSource ? SOURCE_MESSAGE_ID : `msg-${i}`,
      body: `message ${i}`,
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      created_at: new Date(Date.UTC(2026, 8, 1, 12, 0, count - i)).toISOString(),
    });
  }
  return rows;
}

function setup(
  opts: {
    messages?: unknown[];
    conversationPhone?: string;
    sourceMessageId?: string | null;
    draftMissing?: boolean;
    conversationMissing?: boolean;
  } = {}
) {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(eqCalls)) delete eqCalls[k];
  for (const k of Object.keys(orderCalls)) delete orderCalls[k];
  for (const k of Object.keys(limitCalls)) delete limitCalls[k];
  vi.clearAllMocks();

  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'reviewer@example.com' });
  mockResolveTenantContext.mockResolvedValue({
    organizationId: ORG_ID,
    organizationName: 'Panadería La Espiga',
    role: 'owner',
  });
  mockFeatureRpc.mockResolvedValue({ data: true, error: null });

  tables['ai_drafts'] = {
    single: opts.draftMissing
      ? { data: null, error: { code: 'PGRST116' } }
      : {
          data: {
            conversation_id: CONVERSATION_ID,
            source_message_id:
              opts.sourceMessageId === undefined ? SOURCE_MESSAGE_ID : opts.sourceMessageId,
          },
          error: null,
        },
  };
  tables['conversations'] = {
    single: opts.conversationMissing
      ? { data: null, error: { code: 'PGRST116' } }
      : {
          data: {
            id: CONVERSATION_ID,
            contact_phone: opts.conversationPhone ?? '+593991234567',
            status: 'open',
          },
          error: null,
        },
  };
  tables['messages'] = {
    limit: { data: opts.messages ?? messageRows(3, { includeSource: true }), error: null },
  };
}

function request(query = '') {
  return new Request(`http://localhost/api/v1/drafts/${DRAFT_ID}/thread${query}`, {
    headers: { 'x-tenant-id': ORG_ID },
  });
}

async function call(query = '') {
  const res = await threadGET(request(query), { params: Promise.resolve({ draftId: DRAFT_ID }) });
  return { res, body: await res.json() };
}

beforeEach(() => setup());

// --- 1. What crosses the wire ----------------------------------------------

describe('what the response is allowed to contain', () => {
  it('T1: never carries the raw phone number', async () => {
    // THE DEFECT THIS ROUTE WAS BUILT BESIDE. `getConversation` returned
    // `contact_phone` in full on every draft-detail response — serialised, sent
    // to the browser, rendered nowhere. Asserting on the payload rather than on
    // the code is the point: that field was correct-looking code.
    setup({ conversationPhone: '+593991234567' });
    const { res, body } = await call();

    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('+593991234567');
    expect(body.thread.contact_display).toBe('***-***-4567');
  });

  it('T2: carries no provider or operational identifiers', async () => {
    // Amendment 6. `provider_message_id` and `webhook_event_id` are columns on
    // `messages`; a `select('*')` here — the most natural edit anyone will ever
    // make to this query — puts both in the response.
    setup({
      messages: [
        {
          id: 'msg-0',
          body: 'hola',
          direction: 'inbound',
          created_at: '2026-09-01T12:00:00.000Z',
          provider_message_id: 'wamid.SHOULD_NOT_APPEAR',
          webhook_event_id: 'evt-SHOULD_NOT_APPEAR',
        },
      ],
    });
    const { body } = await call();
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain('wamid.SHOULD_NOT_APPEAR');
    expect(serialised).not.toContain('evt-SHOULD_NOT_APPEAR');
    expect(serialised).not.toContain('provider_message_id');
    expect(serialised).not.toContain('webhook_event_id');
  });

  it('T3: asks the database only for the columns it renders', async () => {
    // The other half of T2, one level earlier. T2 passes if the route strips
    // extra columns after fetching them; this fails if they are fetched at all,
    // which is what keeps `select('*')` from being a passing change.
    await call();
    const messagesChain = mockFrom.mock.results
      .map((r) => r.value as Record<string, unknown>)
      .find((_, i) => mockFrom.mock.calls[i][0] === 'messages');
    const selectArg = (messagesChain!.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

    expect(selectArg).toBe('id, body, direction, created_at');
    expect(selectArg).not.toContain('*');
  });
});

// --- 2. What the reviewer is shown -----------------------------------------

describe('what the reviewer reads', () => {
  it('T4: returns messages oldest first, which is reading order', async () => {
    // The query is newest-first because that is how you take "the last N".
    // Showing them that way would have the reviewer reading the conversation
    // backwards, which is a defect no error reports.
    setup({ messages: messageRows(4) });
    const { body } = await call();
    const times = body.thread.messages.map((m: { created_at: string }) => m.created_at);

    expect(times).toEqual([...times].sort());
  });

  it('T5: marks the message the draft is answering, and only that one', async () => {
    // The entire reason the thread is on this screen rather than on its own.
    setup({ messages: messageRows(3, { includeSource: true }) });
    const { body } = await call();
    const flagged = body.thread.messages.filter((m: { is_source: boolean }) => m.is_source);

    expect(flagged).toHaveLength(1);
    expect(flagged[0].id).toBe(SOURCE_MESSAGE_ID);
    expect(body.thread.source_in_window).toBe(true);
  });

  it('T6: says so when the message being answered is not in the window', async () => {
    // Rare, and completely silent if unreported: the reviewer would read a
    // history that does not contain the message the draft replies to and have
    // no way to tell. The draft's own source message is rendered above the
    // thread, so the fix is to say the two are not contiguous.
    setup({ messages: messageRows(3) }); // no row carries SOURCE_MESSAGE_ID
    const { body } = await call();

    expect(body.thread.source_in_window).toBe(false);
    expect(body.thread.messages.every((m: { is_source: boolean }) => !m.is_source)).toBe(true);
  });

  it('T7: marks nothing when the draft has no source message', async () => {
    // `source_message_id` is nullable. Comparing `undefined === undefined` would
    // flag every message as the source, which is worse than flagging none.
    setup({ sourceMessageId: null, messages: messageRows(3) });
    const { body } = await call();

    expect(body.thread.messages.some((m: { is_source: boolean }) => m.is_source)).toBe(false);
    expect(body.thread.source_in_window).toBe(false);
  });

  it('T8: reports older messages rather than stopping silently', async () => {
    // A thread that just ends is one a reviewer reads as complete.
    setup({ messages: messageRows(51) }); // default limit is 50; 51 means more
    const { body } = await call();

    expect(body.thread.has_more).toBe(true);
    expect(body.thread.messages).toHaveLength(50);
  });

  it('T9: reports no more when the conversation fits', async () => {
    setup({ messages: messageRows(3, { includeSource: true }) });
    const { body } = await call();

    expect(body.thread.has_more).toBe(false);
    expect(body.thread.messages).toHaveLength(3);
  });

  it('T10: returns an empty thread rather than a 404 for a new conversation', async () => {
    // A conversation with no messages is a real state, not an error. 404 here
    // would read as "this draft does not exist".
    setup({ messages: [] });
    const { res, body } = await call();

    expect(res.status).toBe(200);
    expect(body.thread.messages).toEqual([]);
    expect(body.thread.has_more).toBe(false);
  });
});

// --- 3. Scoping and bounds --------------------------------------------------

describe('scoping and bounds', () => {
  it('T11: scopes messages to the conversation AND the organization', async () => {
    // RLS answers "may this user see the row". It does not answer "is this row
    // part of the conversation that was asked for" — and this is the request
    // whose entire output is customer message text.
    await call();
    const cols = eqCalls['messages'].map(([c]) => c);

    expect(cols).toContain('conversation_id');
    expect(cols).toContain('organization_id');
    expect(eqCalls['messages']).toContainEqual(['conversation_id', CONVERSATION_ID]);
    expect(eqCalls['messages']).toContainEqual(['organization_id', ORG_ID]);
  });

  it('T12: scopes the draft lookup to the organization', async () => {
    // Otherwise any draft id in the world resolves to its conversation, and the
    // organization filter on the messages query is applied to the wrong one.
    await call();
    expect(eqCalls['ai_drafts']).toContainEqual(['organization_id', ORG_ID]);
    expect(eqCalls['ai_drafts']).toContainEqual(['id', DRAFT_ID]);
  });

  it('T13: orders deterministically, not just by timestamp', async () => {
    // Two messages can share a `created_at` — the ingestion path writes a
    // batch in one transaction. Without a tiebreak the window boundary is
    // unstable, so "the newest 50" can drop a different message each call.
    await call();
    const cols = orderCalls['messages'].map(([c]) => c);
    expect(cols).toEqual(['created_at', 'id']);
  });

  it('T14: asks for one row more than the window, and no more than that', async () => {
    // How `has_more` is computed without a second COUNT that could disagree
    // with the rows it is counting.
    await call();
    expect(limitCalls['messages']).toEqual([51]);
  });

  it('T15: clamps a limit a caller asks for', async () => {
    // `?limit=100000` is a request that this server read a conversation into
    // memory. "The client would not do that" is not a bound.
    await call('?limit=100000');
    expect(limitCalls['messages']).toEqual([201]); // MAX_THREAD_LIMIT + 1

    await call('?limit=0');
    expect(limitCalls['messages'].at(-1)).toBe(2); // clamped up to 1, +1
  });

  it('T16: falls back to the default for a limit that is not a number', async () => {
    // A mistyped query string is not a reason to refuse a reviewer their
    // conversation.
    await call('?limit=abc');
    expect(limitCalls['messages']).toEqual([51]);
  });
});

// --- Auth, gate, and the shapes of failure ---------------------------------

describe('who may read it', () => {
  it('T17: 401 without a user', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    const { res } = await call();
    expect(res.status).toBe(401);
  });

  it('T18: 403 without an active organization', async () => {
    setup();
    mockResolveTenantContext.mockResolvedValue(null);
    const { res } = await call();
    expect(res.status).toBe(403);
  });

  it('T19: 400 for a draft id that is not a UUID', async () => {
    const res = await threadGET(
      new Request('http://localhost/api/v1/drafts/not-a-uuid/thread'),
      { params: Promise.resolve({ draftId: 'not-a-uuid' }) }
    );
    expect(res.status).toBe(400);
  });

  it('T20: 404 when the draft is not this organization’s', async () => {
    setup({ draftMissing: true });
    const { res, body } = await call();
    expect(res.status).toBe(404);
    // Same answer as a draft that does not exist. Whether a given id belongs to
    // someone else is not something an authenticated stranger gets to learn.
    expect(body.error.code).toBe('DRAFT_NOT_FOUND');
  });

  it('T21: 404 when the conversation cannot be resolved', async () => {
    setup({ conversationMissing: true });
    const { res } = await call();
    expect(res.status).toBe(404);
  });

  it('T22: refuses when the feature gate is closed', async () => {
    // The same gate every other draft route passes through. A route that reads
    // customer conversations must not be the one that forgot it.
    setup();
    mockFeatureRpc.mockResolvedValue({ data: false, error: null });
    const { res, body } = await call();

    expect(res.status).toBe(503);
    expect(body.error.code).toBe('FEATURE_UNAVAILABLE');
  });
});
