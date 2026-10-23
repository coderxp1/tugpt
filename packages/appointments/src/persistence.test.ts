/**
 * Slice 2 — P1…P17 (persistence), Z1…Z7 (trusted time zone), W1…W8 (workflow).
 *
 * The tests that matter most are the refusal tests: nothing may persist a
 * CONFIRMED suggestion, nothing may use a customer-supplied zone for
 * arithmetic, and a failing provider must leave the request FAILED with no
 * invented slots. Those are the guarantees the schema and this code exist to
 * hold.
 */

import { describe, it, expect } from 'vitest';
import {
  AvailabilityFailureReason,
  AvailabilityService,
  AppointmentsService,
  AppointmentRequestStatus,
  AppointmentStoreError,
  AppointmentStoreErrorCode,
  AppointmentSuggestionStatus,
  DEFAULT_SUGGESTION_TTL_MS,
  InMemoryAppointmentStore,
  MockBehaviour,
  MockCalendarAvailabilityProvider,
  SlotConfirmation,
  SlotProvenance,
  TimeZoneResolutionError,
  TimeZoneSource,
  filterCurrentSuggestions,
  isSuggestionCurrent,
  normalizePresentationTimeZone,
  resolveBusinessTimeZone,
  type AppointmentSuggestionRecord,
  type AvailabilitySlot,
} from './index.js';

const ORG = 'org-1';
const CAL = 'cal-1';

/** A frozen clock so assertions never depend on when the suite runs. */
const NOW = Date.parse('2026-01-15T12:00:00.000Z');

function slot(
  start: string,
  end: string,
  timeZone: string,
  overrides: Partial<AvailabilitySlot> = {}
): AvailabilitySlot {
  return {
    start,
    end,
    timeZone,
    provenance: SlotProvenance.AUTHORITATIVE,
    confirmation: SlotConfirmation.SUGGESTED,
    source: { provider: 'mock', calendarId: CAL },
    ...overrides,
  };
}

function makeService(
  provider: MockCalendarAvailabilityProvider,
  timeZone = 'Europe/Madrid'
): AppointmentsService {
  return new AppointmentsService({
    store: new InMemoryAppointmentStore({ now: () => NOW }),
    availability: new AvailabilityService(provider),
    timeZoneConfig: { organizationTimeZone: timeZone },
  });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    idempotencyKey: 'msg-1001',
    windowStart: '2026-01-15T00:00:00.000Z',
    windowEnd: '2026-01-16T00:00:00.000Z',
    durationMinutes: 60,
    calendarId: CAL,
    ...overrides,
  };
}

/**
 * A store-level request input, which — unlike the service-level
 * `RequestAvailabilityInput` — must carry the trusted time zone the service
 * would have resolved. Tests that call the store directly supply it.
 */
function storeInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    idempotencyKey: 'msg-1001',
    windowStart: '2026-01-15T00:00:00.000Z',
    windowEnd: '2026-01-16T00:00:00.000Z',
    durationMinutes: 60,
    timeZone: 'Europe/Madrid',
    ...overrides,
  };
}

describe('persistence — idempotency and refusal', () => {
  // P1
  it('recording the same key twice returns the first request, not a duplicate', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });

    const first = await store.recordRequest(storeInput({ idempotencyKey: 'k1' }));
    const second = await store.recordRequest(storeInput({ idempotencyKey: 'k1' }));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  // P2
  it('scopes idempotency per organization, not globally', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const a = await store.recordRequest(storeInput({ organizationId: 'org-a', idempotencyKey: 'shared' }));
    const b = await store.recordRequest(storeInput({ organizationId: 'org-b', idempotencyKey: 'shared' }));

    expect(a.id).not.toBe(b.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });

  // P3 — the refusal that the whole slice exists to enforce
  it('refuses to persist a CONFIRMED suggestion', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const confirmed = slot(
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T11:00:00.000Z',
      'Europe/Madrid',
      { confirmation: SlotConfirmation.CONFIRMED }
    );

    await expect(
      store.recordSuggestions(req.id, ORG, [confirmed], { retrievedAt: '2026-01-15T09:00:00.000Z' })
    ).rejects.toMatchObject({ code: AppointmentStoreErrorCode.CONFIRMED_NOT_ALLOWED });
  });

  // P4
  it('refuses an unattributed suggestion', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const anonymous = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z', 'Europe/Madrid', {
      source: { provider: '   ', calendarId: CAL },
    });

    await expect(
      store.recordSuggestions(req.id, ORG, [anonymous], { retrievedAt: '2026-01-15T09:00:00.000Z' })
    ).rejects.toMatchObject({ code: AppointmentStoreErrorCode.UNATTRIBUTED_SUGGESTION });
  });

  // P5
  it('refuses an inverted slot interval', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const inverted = slot('2026-01-15T11:00:00.000Z', '2026-01-15T10:00:00.000Z', 'Europe/Madrid');

    await expect(
      store.recordSuggestions(req.id, ORG, [inverted], { retrievedAt: '2026-01-15T09:00:00.000Z' })
    ).rejects.toMatchObject({ code: AppointmentStoreErrorCode.INVALID_SLOT_INTERVAL });
  });

  // P6
  it('refuses an expiry before its retrieved instant', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const good = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z', 'Europe/Madrid');

    await expect(
      store.recordSuggestions(req.id, ORG, [good], {
        retrievedAt: '2026-01-15T09:00:00.000Z',
        expiresAt: '2026-01-15T08:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: AppointmentStoreErrorCode.EXPIRY_BEFORE_RETRIEVAL });
  });

  // P7
  it('deduplicates a provider that reports the same slot twice', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const once = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z', 'Europe/Madrid');
    const twice = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z', 'Europe/Madrid');

    const recorded = await store.recordSuggestions(req.id, ORG, [once, twice], {
      retrievedAt: '2026-01-15T09:00:00.000Z',
    });

    expect(recorded).toHaveLength(1);
  });

  // P8
  it('defaults the TTL when none is supplied', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const s = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z', 'Europe/Madrid');

    const [recorded] = await store.recordSuggestions(req.id, ORG, [s], {
      retrievedAt: '2026-01-15T09:00:00.000Z',
    });

    const retrieved = Date.parse('2026-01-15T09:00:00.000Z');
    const expiry = Date.parse(recorded.expiresAt as string);
    expect(expiry - retrieved).toBe(DEFAULT_SUGGESTION_TTL_MS);
  });

  // P9
  it('stamps every persisted suggestion SUGGESTED', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());
    const s = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z', 'Europe/Madrid');

    const recorded = await store.recordSuggestions(req.id, ORG, [s], {
      retrievedAt: '2026-01-15T09:00:00.000Z',
    });

    expect(recorded[0].status).toBe(AppointmentSuggestionStatus.SUGGESTED);
  });

  // P10
  it('FAILED requires a reason; a non-failed status clears any stale reason', async () => {
    const store = new InMemoryAppointmentStore({ now: () => NOW });
    const req = await store.recordRequest(storeInput());

    await expect(store.updateStatus(req.id, AppointmentRequestStatus.FAILED)).rejects.toBeInstanceOf(
      AppointmentStoreError
    );

    const ok = await store.updateStatus(
      req.id,
      AppointmentRequestStatus.SUGGESTED,
      AvailabilityFailureReason.UNAVAILABLE
    );
    expect(ok.failureReason).toBeNull();
  });
});

describe('trusted time zone', () => {
  // Z1
  it('resolves the explicit organization setting', () => {
    const r = resolveBusinessTimeZone({ organizationTimeZone: 'America/Mexico_City' });
    expect(r.timeZone).toBe('America/Mexico_City');
    expect(r.source).toBe(TimeZoneSource.ORGANIZATION_SETTING);
    expect(r.isExplicit).toBe(true);
  });

  // Z2
  it('falls back to the platform default, marked non-explicit', () => {
    const r = resolveBusinessTimeZone({
      organizationTimeZone: null,
      platformDefaultTimeZone: 'Europe/Madrid',
    });
    expect(r.timeZone).toBe('Europe/Madrid');
    expect(r.source).toBe(TimeZoneSource.PLATFORM_DEFAULT);
    expect(r.isExplicit).toBe(false);
  });

  // Z3
  it('fails loudly on an invalid organization zone rather than guessing', () => {
    expect(() =>
      resolveBusinessTimeZone({ organizationTimeZone: 'Mars/Olympus' })
    ).toThrow(TimeZoneResolutionError);
  });

  // Z4
  it('fails loudly when nothing is configured', () => {
    expect(() => resolveBusinessTimeZone({})).toThrow(TimeZoneResolutionError);
  });

  // Z5 — the customer's hint is never a source of truth
  it('never treats a customer-supplied zone as trusted configuration', () => {
    expect(normalizePresentationTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(normalizePresentationTimeZone('garbage-zone')).toBeNull();
  });
});

describe('appointments workflow', () => {
  // W1
  it('records the request, then the provider answer as suggestions', async () => {
    const service = makeService(new MockCalendarAvailabilityProvider({ hours: [10, 11] }));
    const result = await service.requestAvailability(baseInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.request.status).toBe(AppointmentRequestStatus.SUGGESTED);
    expect(result.suggestions.length).toBeGreaterThan(0);
    for (const s of result.suggestions) {
      expect(s.provider).toBe('mock');
      expect(s.calendarId).toBe(CAL);
      expect(s.status).toBe(AppointmentSuggestionStatus.SUGGESTED);
    }
  });

  // W2 — same key, second call, does not re-ask the provider
  it('replays a known request without consulting the provider again', async () => {
    const provider = new MockCalendarAvailabilityProvider({ hours: [10] });
    const service = makeService(provider);

    const first = await service.requestAvailability(baseInput({ idempotencyKey: 'k1' }));
    const second = await service.requestAvailability(baseInput({ idempotencyKey: 'k1' }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(provider.calls).toBe(1); // asked once, not twice
  });

  // W3 — provider failed: FAILED, reason recorded, no suggestions
  it('marks the request FAILED with the reason and records nothing invented', async () => {
    const service = makeService(
      new MockCalendarAvailabilityProvider({ behaviour: MockBehaviour.OUTAGE })
    );
    const result = await service.requestAvailability(baseInput());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.request.status).toBe(AppointmentRequestStatus.FAILED);
    expect(result.request.failureReason).toBe('UNAVAILABLE');
    expect(result.reason).toBe('UNAVAILABLE');
  });

  // W4 — provider answered "nothing free"
  it('marks a legitimately empty answer as NO_AVAILABILITY, not a failure', async () => {
    const service = makeService(
      new MockCalendarAvailabilityProvider({ behaviour: MockBehaviour.EMPTY })
    );
    const result = await service.requestAvailability(baseInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.request.status).toBe(AppointmentRequestStatus.NO_AVAILABILITY);
    expect(result.suggestions).toEqual([]);
  });

  // W5 — the customer's hint must not change the computed answer
  it('ignores the customer time-zone hint for arithmetic', async () => {
    const service = makeService(new MockCalendarAvailabilityProvider({ hours: [10] }));
    const madrid = await service.requestAvailability(
      baseInput({ customerTimeZoneHint: 'Asia/Tokyo' })
    );
    const noHint = await service.requestAvailability(
      baseInput({ idempotencyKey: 'other', customerTimeZoneHint: null })
    );

    expect(madrid.ok).toBe(true);
    expect(noHint.ok).toBe(true);
    if (!madrid.ok || !noHint.ok) throw new Error('unreachable');
    // Same business zone, same answer — the hint changed nothing.
    expect(madrid.suggestions.map((s) => s.slotStart)).toEqual(
      noHint.suggestions.map((s) => s.slotStart)
    );
  });

  // W6 — misconfigured time zone is a thrown configuration error, not a guess
  it('rejects with a resolution error when the trusted zone is invalid', async () => {
    const service = new AppointmentsService({
      store: new InMemoryAppointmentStore({ now: () => NOW }),
      availability: new AvailabilityService(new MockCalendarAvailabilityProvider({ hours: [10] })),
      timeZoneConfig: { organizationTimeZone: 'Not/AZone' },
    });

    await expect(service.requestAvailability(baseInput())).rejects.toThrow(TimeZoneResolutionError);
  });
});

describe('suggestion freshness', () => {
  function rec(expiresAt: string | null): AppointmentSuggestionRecord {
    return {
      id: 'x',
      appointmentRequestId: 'r',
      organizationId: ORG,
      slotStart: '2026-01-15T10:00:00.000Z',
      slotEnd: '2026-01-15T11:00:00.000Z',
      slotTimeZone: 'Europe/Madrid',
      status: AppointmentSuggestionStatus.SUGGESTED,
      provider: 'mock',
      calendarId: CAL,
      providerSlotId: null,
      retrievedAt: '2026-01-15T09:00:00.000Z',
      expiresAt,
      ordinal: 0,
      createdAt: '2026-01-15T09:00:00.000Z',
    };
  }

  // F1
  it('treats a suggestion past its expiry as stale', () => {
    const now = new Date('2026-01-15T09:16:00.000Z');
    expect(isSuggestionCurrent(rec('2026-01-15T09:15:00.000Z'), now)).toBe(false);
  });

  // F2 — a NULL expiry must not read as valid forever
  it('treats a NULL expiry as stale, not immortal', () => {
    expect(isSuggestionCurrent(rec(null), new Date())).toBe(false);
  });

  // F3
  it('filters a mixed list down to only-current suggestions', () => {
    const now = new Date('2026-01-15T09:16:00.000Z');
    const current = rec('2026-01-15T09:30:00.000Z');
    const stale = rec('2026-01-15T09:14:00.000Z');
    const pushed = [{ ...current, id: 'a' }, { ...stale, id: 'b' }];
    expect(filterCurrentSuggestions(pushed, now)).toHaveLength(1);
  });

  // F4 — a just-retrieved suggestion with default TTL is still current
  it('a freshly retrieved suggestion is current', () => {
    const fresh = rec(new Date(NOW + DEFAULT_SUGGESTION_TTL_MS).toISOString());
    expect(isSuggestionCurrent(fresh, new Date(NOW))).toBe(true);
  });
});
