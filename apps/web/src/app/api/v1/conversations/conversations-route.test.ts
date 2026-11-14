/**
 * @file conversations-route.test.ts
 * @description GET /api/v1/conversations — the unified inbox. Sep 25.
 *
 * Four groups, in descending order of what a silent failure would cost:
 *
 *   1. **What crosses the wire.** This endpoint sits on top of the whole
 *      customer list, so it is the one where "only what the screen needs" has
 *      to be enforced rather than intended.
 *   2. **Ordering and paging.** The reason the migration exists, and the
 *      reason the cursor exists: a list that reorders itself under the reader.
 *   3. **Filtering and scoping.** Organization, status, and a limit that
 *      cannot be talked out of by a query string.
 *   4. **Auth and the gate.**
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GET as inboxGET } from './route';
import { encodeCursor } from '@/lib/conversations/cursor';

// --- Supabase harness -------------------------------------------------------
//
// Self-contained for the same reason `thread-route.test.ts` is: this is the
// only route whose query uses `.or()` and `.in()`, and teaching a shared mock
// two new methods changes the object other routes are tested against.

interface TableResults {
  limit?: { data: unknown; error: unknown };
  in?: { data: unknown; error: unknown };
}

const tables: Record<string, TableResults> = {};
const selectCalls: Record<string, string[]> = {};
const eqCalls: Record<string, Array<[string, unknown]>> = {};
const orderCalls: Record<string, Array<[string, unknown]>> = {};
const limitCalls: Record<string, number[]> = {};
const orCalls: Record<string, string[]> = {};
const inCalls: Record<string, Array<[string, unknown]>> = {};
const isCalls: Record<string, Array<[string, unknown]>> = {};

const mockFrom = vi.fn((table: string) => {
  selectCalls[table] ??= [];
  eqCalls[table] ??= [];
  orderCalls[table] ??= [];
  limitCalls[table] ??= [];
  orCalls[table] ??= [];
  inCalls[table] ??= [];
  isCalls[table] ??= [];

  const chain: Record<string, unknown> = {};
  chain.select = vi.fn((cols: string) => {
    selectCalls[table].push(cols);
    return chain;
  });
  chain.eq = vi.fn((col: string, val: unknown) => {
    eqCalls[table].push([col, val]);
    return chain;
  });
  chain.or = vi.fn((expr: string) => {
    orCalls[table].push(expr);
    return chain;
  });
  chain.is = vi.fn((col: string, val: unknown) => {
    isCalls[table].push([col, val]);
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
  chain.in = vi.fn((col: string, vals: unknown) => {
    inCalls[table].push([col, vals]);
    return Promise.resolve(tables[table]?.in ?? { data: [], error: null });
  });
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

const ORG_ID = 'org-1';
const CONV = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-1111-1111-111111111111`;

function conversationRows(count: number, overrides: Record<string, unknown> = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: CONV(i),
      contact_phone: `+59399123456${i}`,
      status: 'open',
      activity_at: new Date(Date.UTC(2026, 8, 1, 12, 0, count - i)).toISOString(),
      ...overrides,
    });
  }
  return rows;
}

function setup(
  opts: {
    conversations?: unknown[];
    draftRows?: unknown[];
    profileRows?: unknown[];
    gateOpen?: boolean;
  } = {}
) {
  for (const bag of [tables, selectCalls, eqCalls, orderCalls, limitCalls, orCalls, inCalls, isCalls]) {
    for (const k of Object.keys(bag)) delete (bag as Record<string, unknown>)[k];
  }
  vi.clearAllMocks();

  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'reviewer@example.com' });
  mockResolveTenantContext.mockResolvedValue({
    organizationId: ORG_ID,
    organizationName: 'Panadería La Espiga',
    role: 'owner',
  });
  mockFeatureRpc.mockResolvedValue({ data: opts.gateOpen ?? true, error: null });

  tables['conversations'] = {
    limit: { data: opts.conversations ?? conversationRows(3), error: null },
  };
  tables['ai_drafts'] = { in: { data: opts.draftRows ?? [], error: null } };
  tables['profiles'] = { in: { data: opts.profileRows ?? [], error: null } };
}

function request(query = '') {
  return new Request(`http://localhost/api/v1/conversations${query}`, {
    headers: { 'x-tenant-id': ORG_ID },
  });
}

async function call(query = '') {
  const res = await inboxGET(request(query));
  return { res, body: await res.json() };
}

beforeEach(() => setup());

// --- 1. What crosses the wire ----------------------------------------------

describe('what the response is allowed to contain', () => {
  it('T1: masks the contact and never carries a raw number', async () => {
    setup({ conversations: [{ id: CONV(1), contact_phone: '+593991234567', status: 'open', activity_at: '2026-09-01T10:00:00.000Z' }] });
    const { res, body } = await call();

    expect(res.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('+593991234567');
    expect(body.conversations[0].contact_display).toBe('***-***-4567');
    expect(JSON.stringify(body)).not.toContain('contact_phone');
  });

  it('T2: carries no message text and no connection identifiers', async () => {
    // A preview is the obvious row decoration and the single largest expansion
    // of customer data this product could make. `select('*')` here would add
    // `whatsapp_connection_id` too.
    setup({
      conversations: [
        {
          id: CONV(1),
          contact_phone: '+593991234567',
          status: 'open',
          activity_at: '2026-09-01T10:00:00.000Z',
          whatsapp_connection_id: 'conn-SHOULD_NOT_APPEAR',
          last_message_body: 'SHOULD_NOT_APPEAR',
        },
      ],
    });
    const serialised = JSON.stringify((await call()).body);

    expect(serialised).not.toContain('SHOULD_NOT_APPEAR');
    expect(serialised).not.toContain('whatsapp_connection_id');
  });

  it('T3: asks the database only for the columns it renders', async () => {
    // The other half of T2, one level earlier: T2 passes if the route strips
    // extra columns after fetching them, this fails if they are fetched.
    await call();
    expect(selectCalls['conversations'][0]).toBe(
      'id, contact_phone, status, activity_at, assigned_to'
    );
    expect(selectCalls['conversations'][0]).not.toContain('*');
  });

  it('T4: returns no total count', async () => {
    // Deliberate. A count and the rows it counts are read at different moments
    // in a list that reorders itself, so "1-20 of 47" can disagree with what is
    // on screen. `next_cursor` answers the question a Next button asks.
    const { body } = await call();
    expect(body).not.toHaveProperty('total');
    expect(body).toHaveProperty('next_cursor');
  });
});

// --- 2. Ordering and paging -------------------------------------------------

describe('ordering and paging', () => {
  it('T5: orders by activity_at and not by last_message_at', async () => {
    // The whole point of migration 20260901000001. `last_message_at` is
    // nullable and DESC implies NULLS FIRST, so ordering on it puts the
    // conversation with an unreadable webhook timestamp above every recent one.
    await call();
    const cols = orderCalls['conversations'].map(([c]) => c);

    expect(cols).toEqual(['activity_at', 'id']);
    expect(cols).not.toContain('last_message_at');
  });

  it('T6: orders both keys descending', async () => {
    await call();
    for (const [, opts] of orderCalls['conversations']) {
      expect(opts).toMatchObject({ ascending: false });
    }
  });

  it('T7: asks for one row more than the page', async () => {
    await call();
    expect(limitCalls['conversations']).toEqual([26]); // DEFAULT_INBOX_LIMIT + 1
  });

  it('T8: emits a cursor only when there is another page', async () => {
    setup({ conversations: conversationRows(26) }); // 25 + the probe row
    const { body } = await call();

    expect(body.conversations).toHaveLength(25);
    expect(body.next_cursor).not.toBeNull();
  });

  it('T9: emits no cursor on the last page', async () => {
    // A cursor here gives the UI a Next button that fetches an empty page.
    setup({ conversations: conversationRows(3) });
    const { body } = await call();

    expect(body.conversations).toHaveLength(3);
    expect(body.next_cursor).toBeNull();
  });

  it('T10: emits no cursor for an empty inbox', async () => {
    setup({ conversations: [] });
    const { body } = await call();

    expect(body.conversations).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('T11: the cursor names the last row of the page, not the probe row', async () => {
    // Off by one here means the first row of page two is the last row of page
    // one repeated, or the probe row is skipped entirely.
    setup({ conversations: conversationRows(26) });
    const { body } = await call('?limit=25');

    const last = body.conversations[body.conversations.length - 1];
    const decoded = JSON.parse(Buffer.from(body.next_cursor, 'base64url').toString('utf8'));
    expect(decoded).toEqual([last.activity_at, last.id]);
  });

  it('T12: a cursor becomes a strictly-after filter, tie included', async () => {
    // `(activity_at, id) < (:at, :id)` written as an OR, because PostgREST has
    // no row-value comparison. Without the tie branch, conversations sharing an
    // activity_at are skipped at the page boundary.
    const at = '2026-09-01T12:00:00.000Z';
    const id = CONV(7);
    await call(`?cursor=${encodeCursor({ activityAt: at, id })}`);

    expect(orCalls['conversations']).toEqual([
      `activity_at.lt.${at},and(activity_at.eq.${at},id.lt.${id})`,
    ]);
  });

  it('T13: no cursor means no filter at all', async () => {
    await call();
    expect(orCalls['conversations']).toEqual([]);
  });
});

// --- 3. Filtering, scoping, bounds -----------------------------------------

describe('filtering and scoping', () => {
  it('T14: scopes every query to the organization', async () => {
    setup({ draftRows: [{ conversation_id: CONV(0) }] });
    await call();

    expect(eqCalls['conversations']).toContainEqual(['organization_id', ORG_ID]);
    expect(eqCalls['ai_drafts']).toContainEqual(['organization_id', ORG_ID]);
  });

  it('T15: applies a status filter when one is asked for', async () => {
    await call('?status=needs_human');
    expect(eqCalls['conversations']).toContainEqual(['status', 'needs_human']);
  });

  it('T16: applies no status filter for "all"', async () => {
    await call('?status=all');
    expect(eqCalls['conversations'].map(([c]) => c)).not.toContain('status');
  });

  it('T17: refuses a status outside the vocabulary', async () => {
    const { res, body } = await call('?status=archived');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_QUERY');
  });

  it('T18: clamps a limit a caller asks for', async () => {
    await call('?limit=100000');
    expect(limitCalls['conversations']).toEqual([101]); // MAX_INBOX_LIMIT + 1

    await call('?limit=0');
    expect(limitCalls['conversations'].at(-1)).toBe(2); // clamped up to 1, +1
  });

  it('T19: falls back to the default for a limit that is not a number', async () => {
    await call('?limit=abc');
    expect(limitCalls['conversations']).toEqual([26]);
  });

  it('T19b: filters to unassigned with IS NULL, not an equality on null', async () => {
    await call('?assignment=unassigned');
    expect(isCalls['conversations']).toContainEqual(['assigned_to', null]);
  });

  it('T19c: filters to mine using the signed-in reviewer, never a client-supplied id', async () => {
    // The viewer comes from the session, not the query string. A caller that
    // could name the reviewer could read someone else's queue.
    await call('?assignment=mine');
    expect(eqCalls['conversations']).toContainEqual(['assigned_to', 'user-1']);
  });

  it('T19d: applies no assignment filter by default', async () => {
    await call();
    expect(isCalls['conversations']).toEqual([]);
    expect(eqCalls['conversations'].map(([c]) => c)).not.toContain('assigned_to');
  });

  it('T19e: refuses an assignment filter outside the vocabulary', async () => {
    const { res, body } = await call('?assignment=everyone');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_QUERY');
  });

  it('T20: refuses a malformed cursor rather than silently returning page one', async () => {
    // The deliberate asymmetry with T19. A limit is how the answer is
    // presented; a cursor is part of the question. Ignoring it answers a
    // different question, and a Next button turns that into a loop through the
    // same rows forever.
    const { res, body } = await call('?cursor=not-a-real-cursor');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_QUERY');
  });
});

describe('what is waiting for review', () => {
  it('T21: links a conversation to the draft waiting on it', async () => {
    setup({
      conversations: conversationRows(3),
      draftRows: [
        { id: 'draft-for-1', conversation_id: CONV(1), created_at: '2026-09-01T10:00:00.000Z' },
      ],
    });
    const { body } = await call();

    const flagged = body.conversations.filter(
      (c: { awaiting_draft_id: string | null }) => c.awaiting_draft_id !== null
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].id).toBe(CONV(1));
    expect(flagged[0].awaiting_draft_id).toBe('draft-for-1');
  });

  it('T21b: picks the newest draft when a conversation has more than one', async () => {
    // `ai_drafts` is unique per source message, not per conversation, so two
    // unanswered inbound messages leave two drafts on one conversation. Which
    // one the row opens must not be "whichever the database listed first".
    setup({
      conversations: conversationRows(1),
      draftRows: [
        { id: 'newer', conversation_id: CONV(0), created_at: '2026-09-02T10:00:00.000Z' },
        { id: 'older', conversation_id: CONV(0), created_at: '2026-09-01T10:00:00.000Z' },
      ],
    });
    const { body } = await call();

    expect(body.conversations[0].awaiting_draft_id).toBe('newer');
    // ...and the order is asked of the database rather than assumed of the rows.
    expect(orderCalls['ai_drafts'].map(([c]) => c)).toEqual(['created_at', 'id']);
  });

  it('T21c: reports null when nothing is waiting', async () => {
    setup({ conversations: conversationRows(2), draftRows: [] });
    const { body } = await call();

    for (const c of body.conversations) {
      expect(c.awaiting_draft_id).toBeNull();
    }
  });

  it('T22: asks only about drafts still awaiting review', async () => {
    await call();
    expect(eqCalls['ai_drafts']).toContainEqual(['status', 'draft']);
  });

  it('T23: asks about the whole page in one query, not one per row', async () => {
    // `listDrafts` issues two extra queries per row, so a 20-row page there is
    // 41 round trips. Asserted rather than intended, because the per-row
    // version is the easier thing to write and produces identical output.
    setup({ conversations: conversationRows(10) });
    await call();

    expect(inCalls['ai_drafts']).toHaveLength(1);
    expect(inCalls['ai_drafts'][0][0]).toBe('conversation_id');
    expect((inCalls['ai_drafts'][0][1] as string[])).toHaveLength(10);
    expect(mockFrom.mock.calls.filter((c) => c[0] === 'ai_drafts')).toHaveLength(1);
    // And it asks only for what it needs from that table.
    expect(selectCalls['ai_drafts'][0]).toBe('id, conversation_id, created_at');
  });

  it('T23b: resolves assignee names once per page, deduplicated', async () => {
    setup({
      conversations: conversationRows(4, { assigned_to: 'reviewer-1' }),
      profileRows: [{ id: 'reviewer-1', full_name: 'Ana Reviewer', email: 'ana@example.com' }],
    });
    const { body } = await call();

    expect(inCalls['profiles']).toHaveLength(1);
    expect((inCalls['profiles'][0][1] as string[])).toEqual(['reviewer-1']);
    expect(body.conversations[0].assigned_to).toEqual({ id: 'reviewer-1', display: 'Ana Reviewer' });
  });

  it('T23c: falls back to email, then to the id, rather than rendering blank', async () => {
    setup({
      conversations: [
        { ...conversationRows(1)[0], assigned_to: 'no-name' },
        { ...conversationRows(1)[0], id: CONV(7), assigned_to: 'no-profile' },
      ],
      profileRows: [{ id: 'no-name', full_name: null, email: 'someone@example.com' }],
    });
    const { body } = await call();

    expect(body.conversations[0].assigned_to.display).toBe('someone@example.com');
    expect(body.conversations[1].assigned_to.display).toBe('no-profile');
  });

  it('T23d: does not query profiles when nothing on the page is assigned', async () => {
    setup({ conversations: conversationRows(3) });
    await call();
    expect(mockFrom.mock.calls.filter((c) => c[0] === 'profiles')).toHaveLength(0);
  });

  it('T24: does not query drafts at all for an empty page', async () => {
    setup({ conversations: [] });
    await call();
    expect(mockFrom.mock.calls.filter((c) => c[0] === 'ai_drafts')).toHaveLength(0);
  });
});

// --- 4. Auth and the gate ---------------------------------------------------

describe('who may read it', () => {
  it('T25: 401 without a user', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await call()).res.status).toBe(401);
  });

  it('T26: 403 without an active organization', async () => {
    setup();
    mockResolveTenantContext.mockResolvedValue(null);
    expect((await call()).res.status).toBe(403);
  });

  it('T27: refuses when the feature gate is closed', async () => {
    // The same gate every other reviewer-facing route passes through. An inbox
    // that worked while every draft it links to answered 503 would be a door
    // to nothing.
    setup({ gateOpen: false });
    const { res, body } = await call();

    expect(res.status).toBe(503);
    expect(body.error.code).toBe('FEATURE_UNAVAILABLE');
  });

  it('T28: checks the gate before reading any conversation', async () => {
    setup({ gateOpen: false });
    await call();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
