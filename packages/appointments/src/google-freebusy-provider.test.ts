/**
 * Google FreeBusy provider — G1…G16.
 *
 * The assertions that matter most are the negative ones: a disabled flag must
 * mean zero network traffic, a failure must never resolve to slots, and the
 * credential must never appear in a log or a detail string. Those are
 * G1–G2, G5–G14.
 *
 * Every network interaction goes through an injected stub, so no test needs
 * credentials, touches Google, or depends on the clock.
 */

import { describe, it, expect } from 'vitest';
import {
  GoogleFreeBusyProvider,
  GOOGLE_FREEBUSY_SCOPE,
  GOOGLE_FREEBUSY_FLAG_KEY,
  type FreeBusyFetch,
  type FreeBusyFetchInit,
  type FreeBusyFetchResponse,
} from './index.js';
import {
  AvailabilityFailureReason,
  SlotConfirmation,
  SlotProvenance,
  type AvailabilityQuery,
} from './provider.js';

const CAL = 'cal-google-1';
const TOKEN = 'tok-secret-1';
const NOW = Date.parse('2026-01-15T12:00:00.000Z');

function gQuery(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    window: {
      start: '2026-01-15T00:00:00.000Z',
      end: '2026-01-15T04:00:00.000Z',
    },
    durationMinutes: 60,
    timeZone: 'Europe/Madrid',
    calendarId: CAL,
    ...overrides,
  };
}

interface StubCall {
  url: string;
  init: FreeBusyFetchInit;
}

interface StubBehavior {
  status: number;
  body?: unknown;
  /** Make response.json() throw, simulating a non-JSON payload. */
  throwJson?: boolean;
}

/** A programmable `fetch` that records every call it received. */
class StubFetch {
  readonly calls: StubCall[] = [];
  readonly behaviors: StubBehavior[] = [];
  fetchError: Error | null = null;
  /** Never resolve unless the abort signal fires (timeout simulation). */
  hangUntilAbort = false;

  get fetchFn(): FreeBusyFetch {
    return async (url: string, init: FreeBusyFetchInit) => {
      this.calls.push({ url, init });
      if (this.fetchError !== null) throw this.fetchError;
      if (this.hangUntilAbort) {
        await new Promise<void>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
        throw new Error('unreachable');
      }
      const behavior = this.behaviors.shift() ?? { status: 200, body: {} };
      const response: FreeBusyFetchResponse = {
        status: behavior.status,
        json: async () => {
          if (behavior.throwJson === true) throw new Error('invalid json');
          return behavior.body ?? {};
        },
      };
      return response;
    };
  }
}

function freebusyOk(
  busy: Array<{ start: string; end: string }>,
  calendarId: string = CAL
): unknown {
  return { calendars: { [calendarId]: { busy } } };
}

function provider(
  stub: StubFetch,
  options: {
    enabled?: boolean;
    token?: string | null;
    refreshToken?: string | null;
    timeoutMs?: number;
  } = {}
): { provider: GoogleFreeBusyProvider; counts: { token: number; refresh: number } } {
  const counts = { token: 0, refresh: 0 };
  const p = new GoogleFreeBusyProvider({
    enabled: options.enabled,
    getAccessToken: async () => {
      counts.token += 1;
      return options.token === undefined ? TOKEN : options.token;
    },
    refreshAccessToken: async () => {
      counts.refresh += 1;
      return options.refreshToken === undefined ? 'tok-refreshed' : options.refreshToken;
    },
    fetchFn: stub.fetchFn,
    timeoutMs: options.timeoutMs,
    now: () => NOW,
  });
  return { provider: p, counts };
}

describe('google freebusy — disabled by default', () => {
  // G1 — the flag is the only gate that matters when off
  it('answers NOT_CONFIGURED without touching the network when disabled', async () => {
    const stub = new StubFetch();
    const { provider: p, counts } = provider(stub);

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.NOT_CONFIGURED);
    expect(result.detail).toContain('feature flag');
    expect(result.slots).toEqual([]);
    expect(stub.calls).toHaveLength(0);
    expect(counts.token).toBe(0);
  });

  // G2
  it('answers NOT_CONFIGURED without a network call when no token exists', async () => {
    const stub = new StubFetch();
    const { provider: p } = provider(stub, { enabled: true, token: null });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.NOT_CONFIGURED);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('google freebusy — happy path', () => {
  // G3
  it('packs duration-sized slots into the free intervals', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({
      status: 200,
      body: freebusyOk([
        { start: '2026-01-15T01:00:00.000Z', end: '2026-01-15T01:30:00.000Z' },
      ]),
    });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // 00:00-01:00 free -> [00:00,01:00]; 01:30-04:00 free -> [01:30,02:30],[02:30,03:30].
    expect(result.slots.map((s) => [s.start, s.end])).toEqual([
      ['2026-01-15T00:00:00.000Z', '2026-01-15T01:00:00.000Z'],
      ['2026-01-15T01:30:00.000Z', '2026-01-15T02:30:00.000Z'],
      ['2026-01-15T02:30:00.000Z', '2026-01-15T03:30:00.000Z'],
    ]);
    for (const slot of result.slots) {
      expect(slot.confirmation).toBe(SlotConfirmation.SUGGESTED);
      expect(slot.confirmation).not.toBe(SlotConfirmation.CONFIRMED);
      expect(slot.provenance).toBe(SlotProvenance.AUTHORITATIVE);
      expect(slot.timeZone).toBe('Europe/Madrid');
      expect(slot.source.provider).toBe('google-calendar');
      expect(slot.source.calendarId).toBe(CAL);
    }
    expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
  });

  // G3b — the request shape the service relies on
  it('sends a single read-only freebusy query with the bearer token', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({ status: 200, body: freebusyOk([]) });
    const { provider: p } = provider(stub, { enabled: true });

    await p.findAvailability(gQuery());

    expect(stub.calls).toHaveLength(1);
    const { url, init } = stub.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['timeMin']).toBe('2026-01-15T00:00:00.000Z');
    expect(body['timeMax']).toBe('2026-01-15T04:00:00.000Z');
    expect(body['timeZone']).toBe('Europe/Madrid');
    expect(body['items']).toEqual([{ id: CAL }]);
  });

  // G4 — a fully booked calendar is a successful empty answer
  it('reports a fully-busy window as success with zero slots', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({
      status: 200,
      body: freebusyOk([
        { start: '2026-01-15T00:00:00.000Z', end: '2026-01-15T04:00:00.000Z' },
      ]),
    });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toEqual([]);
  });

  // G16 — busy blocks are clipped to the window, not trusted past it
  it('clips busy blocks that extend past the window edges', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({
      status: 200,
      body: freebusyOk([
        { start: '2026-01-14T23:00:00.000Z', end: '2026-01-15T01:00:00.000Z' },
        { start: '2026-01-15T03:30:00.000Z', end: '2026-01-15T06:00:00.000Z' },
      ]),
    });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Free: 01:00-03:30 -> [01:00,02:00],[02:00,03:00].
    expect(result.slots.map((s) => [s.start, s.end])).toEqual([
      ['2026-01-15T01:00:00.000Z', '2026-01-15T02:00:00.000Z'],
      ['2026-01-15T02:00:00.000Z', '2026-01-15T03:00:00.000Z'],
    ]);
  });
});

describe('google freebusy — credentials', () => {
  // G5 — expired credentials get one refresh, then succeed
  it('retries once with a refreshed token after a 401', async () => {
    const stub = new StubFetch();
    stub.behaviors.push(
      { status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } },
      { status: 200, body: freebusyOk([]) }
    );
    const { provider: p, counts } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(true);
    expect(counts.refresh).toBe(1);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].init.headers['Authorization']).toBe('Bearer tok-refreshed');
  });

  // G6 — a 401 with no refresh hook is a typed failure, not an exception
  it('maps 401 without refresh to NOT_AUTHORIZED', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({ status: 401, body: {} });
    const p = new GoogleFreeBusyProvider({
      enabled: true,
      getAccessToken: async () => TOKEN,
      fetchFn: stub.fetchFn,
      now: () => NOW,
    });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.NOT_AUTHORIZED);
    expect(result.slots).toEqual([]);
  });

  // G7 — quota denials are retryable; other 403s are credential problems
  it('distinguishes quota 403s from authorization 403s', async () => {
    const quotaStub = new StubFetch();
    quotaStub.behaviors.push({
      status: 403,
      body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
    });
    const { provider: quotaP } = provider(quotaStub, { enabled: true });
    const quotaResult = await quotaP.findAvailability(gQuery());
    expect(quotaResult.ok).toBe(false);
    if (quotaResult.ok) throw new Error('unreachable');
    expect(quotaResult.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);

    const authStub = new StubFetch();
    authStub.behaviors.push({
      status: 403,
      body: { error: { errors: [{ reason: 'forbidden' }] } },
    });
    const { provider: authP } = provider(authStub, { enabled: true });
    const authResult = await authP.findAvailability(gQuery());
    expect(authResult.ok).toBe(false);
    if (authResult.ok) throw new Error('unreachable');
    expect(authResult.reason).toBe(AvailabilityFailureReason.NOT_AUTHORIZED);
  });
});

describe('google freebusy — transport and provider faults', () => {
  // G8
  it('maps HTTP 429 to UNAVAILABLE', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({ status: 429, body: {} });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
    expect(result.slots).toEqual([]);
  });

  // G9
  it('maps HTTP 500 to UNAVAILABLE', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({ status: 500, body: {} });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
  });

  // G10 — a throwing fetch must not become a rejecting provider
  it('contains a fetch that throws', async () => {
    const stub = new StubFetch();
    stub.fetchError = new Error('socket hang up');
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
    expect(result.detail).toContain('socket hang up');
  });

  // G11
  it('maps a timeout to UNAVAILABLE', async () => {
    const stub = new StubFetch();
    stub.hangUntilAbort = true;
    const { provider: p } = provider(stub, { enabled: true, timeoutMs: 5 });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
    expect(result.detail).toContain('timed out');
  });

  // G13a — the calendar does not exist: setup, not outage
  it('maps a per-calendar notFound error to NOT_CONFIGURED', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({
      status: 200,
      body: { calendars: { [CAL]: { errors: [{ reason: 'notFound' }] } } },
    });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.NOT_CONFIGURED);
    expect(result.slots).toEqual([]);
  });

  // G13b
  it('maps other per-calendar errors to UNAVAILABLE', async () => {
    const stub = new StubFetch();
    stub.behaviors.push({
      status: 200,
      body: { calendars: { [CAL]: { errors: [{ reason: 'internalError' }] } } },
    });
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
  });
});

describe('google freebusy — untrustworthy payloads', () => {
  // G12 — every malformed shape ends the same way: no answer, not a partial one
  it.each([
    ['non-JSON body', { status: 200, throwJson: true }],
    ['missing calendars object', { status: 200, body: {} }],
    [
      'unparseable busy instant',
      { status: 200, body: freebusyOk([{ start: 'whenever', end: 'later' }]) },
    ],
    [
      'inverted busy interval',
      {
        status: 200,
        body: freebusyOk([
          { start: '2026-01-15T02:00:00.000Z', end: '2026-01-15T01:00:00.000Z' },
        ]),
      },
    ],
  ])('rejects a %s as MALFORMED_RESPONSE', async (_label, behavior) => {
    const stub = new StubFetch();
    stub.behaviors.push(behavior);
    const { provider: p } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.MALFORMED_RESPONSE);
    expect(result.slots).toEqual([]);
  });

  // G14 — the token must never appear in an outcome
  it('never leaks the token into failure details', async () => {
    const scenarios: StubBehavior[] = [
      { status: 401, body: {} },
      { status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } },
      { status: 500, body: {} },
    ];
    for (const behavior of scenarios) {
      const stub = new StubFetch();
      stub.behaviors.push(behavior);
      const { provider: p } = provider(stub, { enabled: true });
      const result = await p.findAvailability(gQuery());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.detail).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  // G15 — malformed input never reaches the network
  it('rejects an invalid query without calling fetch', async () => {
    const stub = new StubFetch();
    const { provider: p, counts } = provider(stub, { enabled: true });

    const result = await p.findAvailability(gQuery({ timeZone: 'Mars/Olympus' }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.INVALID_REQUEST);
    expect(stub.calls).toHaveLength(0);
    expect(counts.token).toBe(0);
  });
});

describe('google freebusy — public constants', () => {
  it('exports the least-privilege scope and the flag key', () => {
    expect(GOOGLE_FREEBUSY_SCOPE).toBe(
      'https://www.googleapis.com/auth/calendar.freebusy'
    );
    expect(GOOGLE_FREEBUSY_FLAG_KEY).toBe('google_calendar_freebusy');
  });
});
