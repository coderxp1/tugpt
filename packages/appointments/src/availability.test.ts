/**
 * Availability slice — A1…A24.
 *
 * The assertions that matter most are the negative ones. It is easy to write a
 * service that returns plausible times; the requirement is a service that
 * returns nothing when it does not know, and never claims a booking it did not
 * make. Those are A5–A14 and A22–A24.
 */

import { describe, it, expect } from 'vitest';
import {
  AvailabilityService,
  AvailabilityFailureReason,
  MockBehaviour,
  MockCalendarAvailabilityProvider,
  SlotConfirmation,
  SlotProvenance,
  MAX_SLOT_LIMIT,
  offsetMsAt,
  validateQuery,
  type AvailabilityQuery,
} from './index.js';

const MADRID = 'Europe/Madrid';
const MEXICO_CITY = 'America/Mexico_City';

/** A fixed winter window, so no assertion depends on when the suite runs. */
function winterQuery(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    window: {
      start: '2026-01-15T00:00:00.000Z',
      end: '2026-01-16T00:00:00.000Z',
    },
    durationMinutes: 60,
    timeZone: MADRID,
    calendarId: 'cal-1',
    ...overrides,
  };
}

describe('availability — provider failure returns nothing invented', () => {
  // A5
  it('returns an empty, typed failure on provider outage', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ behaviour: MockBehaviour.OUTAGE })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
    expect(result.slots).toEqual([]);
  });

  // A6
  it('returns an empty, typed failure when credentials are rejected', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({
        behaviour: MockBehaviour.UNAUTHORIZED,
      })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.NOT_AUTHORIZED);
    expect(result.slots).toEqual([]);
  });

  // A7
  it('distinguishes "no calendar configured" from "unreachable"', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({
        behaviour: MockBehaviour.NOT_CONFIGURED,
      })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.NOT_CONFIGURED);
  });

  // A8 — a provider that violates its own contract must not break the caller
  it('contains a provider that throws instead of returning', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ behaviour: MockBehaviour.THROWS })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.UNAVAILABLE);
    expect(result.detail).toContain('threw');
    expect(result.slots).toEqual([]);
  });

  // A9 — malformed provider payloads are refused, not partially trusted
  it('drops every malformed slot a provider sends', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ behaviour: MockBehaviour.MALFORMED })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Both garbage slots were rejected: a bad instant and an inverted range.
    expect(result.slots).toEqual([]);
  });

  // A10 — a legitimate empty answer is not an error
  it('reports a fully-booked calendar as success with zero slots', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ behaviour: MockBehaviour.EMPTY })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toEqual([]);
  });

  // A11 — recovery after a transient outage
  it('succeeds on a later call after a first-call outage', async () => {
    const provider = new MockCalendarAvailabilityProvider({
      behaviour: [MockBehaviour.OUTAGE, MockBehaviour.AVAILABLE],
      hours: [10],
    });
    const service = new AvailabilityService(provider);

    const first = await service.findAvailability(winterQuery());
    const second = await service.findAvailability(winterQuery());

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.slots.length).toBeGreaterThan(0);
  });
});

describe('availability — never claims a confirmed booking', () => {
  // A12 — the central guarantee of this slice
  it('stamps every returned slot SUGGESTED, never CONFIRMED', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [9, 10, 11] })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots.length).toBeGreaterThan(0);
    for (const slot of result.slots) {
      expect(slot.confirmation).toBe(SlotConfirmation.SUGGESTED);
      expect(slot.confirmation).not.toBe(SlotConfirmation.CONFIRMED);
    }
  });

  // A13 — provenance is stamped by the service, from the provider's own answer
  it('stamps every slot AUTHORITATIVE with the answering provider named', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [10] })
    );

    const result = await service.findAvailability(winterQuery());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    for (const slot of result.slots) {
      expect(slot.provenance).toBe(SlotProvenance.AUTHORITATIVE);
      expect(slot.source.provider).toBe('mock');
      expect(slot.source.calendarId).toBe('cal-1');
    }
  });

  // A14 — a failing provider cannot smuggle slots through the ok:false branch
  it('never returns slots alongside a failure', async () => {
    for (const behaviour of [
      MockBehaviour.OUTAGE,
      MockBehaviour.UNAUTHORIZED,
      MockBehaviour.NOT_CONFIGURED,
    ]) {
      const service = new AvailabilityService(
        new MockCalendarAvailabilityProvider({ behaviour })
      );
      const result = await service.findAvailability(winterQuery());
      expect(result.ok).toBe(false);
      expect(result.slots).toEqual([]);
    }
  });
});

describe('availability — invalid input never reaches the provider', () => {
  // A15
  it('rejects an invalid request without calling the provider', async () => {
    const provider = new MockCalendarAvailabilityProvider({ hours: [10] });
    const service = new AvailabilityService(provider);

    const result = await service.findAvailability(
      winterQuery({
        window: { start: 'not-a-date', end: '2026-01-16T00:00:00.000Z' },
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe(AvailabilityFailureReason.INVALID_REQUEST);
    expect(provider.calls).toBe(0);
  });

  // A16
  it('rejects an unknown time zone', () => {
    const validation = validateQuery(winterQuery({ timeZone: 'Mars/Olympus' }));
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error('unreachable');
    expect(validation.detail).toContain('time zone');
  });

  // A17 — date-only strings are a classic silent off-by-one
  it('rejects a date-only window start', () => {
    const validation = validateQuery(
      winterQuery({
        window: { start: '2026-01-15', end: '2026-01-16T00:00:00.000Z' },
      })
    );
    expect(validation.ok).toBe(false);
  });

  // A18
  it('rejects a non-positive duration', async () => {
    const provider = new MockCalendarAvailabilityProvider();
    const service = new AvailabilityService(provider);

    for (const durationMinutes of [0, -15, 1.5]) {
      const result = await service.findAvailability(
        winterQuery({ durationMinutes })
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe(AvailabilityFailureReason.INVALID_REQUEST);
    }
    expect(provider.calls).toBe(0);
  });

  // A19
  it('rejects an inverted or empty window', () => {
    const validation = validateQuery(
      winterQuery({
        window: {
          start: '2026-01-16T00:00:00.000Z',
          end: '2026-01-15T00:00:00.000Z',
        },
      })
    );
    expect(validation.ok).toBe(false);
  });

  // A20 — a duration longer than the window would read as "fully booked"
  it('rejects a duration longer than the requested window', () => {
    const validation = validateQuery(
      winterQuery({
        window: {
          start: '2026-01-15T00:00:00.000Z',
          end: '2026-01-15T00:30:00.000Z',
        },
        durationMinutes: 60,
      })
    );
    expect(validation.ok).toBe(false);
  });

  // A21
  it('caps an oversized limit rather than rejecting it', () => {
    const validation = validateQuery(winterQuery({ limit: 10_000 }));
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error('unreachable');
    expect(validation.normalized.limit).toBe(MAX_SLOT_LIMIT);
  });
});

describe('availability — time zones', () => {
  // A22 — the same wall-clock hour is a different instant in each zone
  it('produces zone-correct instants for the same local hour', async () => {
    const provider = new MockCalendarAvailabilityProvider({ hours: [10] });

    const madrid = new AvailabilityService(provider);
    const mexico = new AvailabilityService(provider);

    const madridResult = await madrid.findAvailability(
      winterQuery({ timeZone: MADRID })
    );
    const mexicoResult = await mexico.findAvailability(
      winterQuery({ timeZone: MEXICO_CITY })
    );

    expect(madridResult.ok).toBe(true);
    expect(mexicoResult.ok).toBe(true);
    if (!madridResult.ok || !mexicoResult.ok) throw new Error('unreachable');

    const madridSlot = madridResult.slots[0];
    const mexicoSlot = mexicoResult.slots[0];
    expect(madridSlot).toBeDefined();
    expect(mexicoSlot).toBeDefined();

    // Both are 10:00 locally; the instants differ, and each slot carries the
    // zone it was computed in.
    expect(madridSlot.timeZone).toBe(MADRID);
    expect(mexicoSlot.timeZone).toBe(MEXICO_CITY);
    expect(madridSlot.start).not.toBe(mexicoSlot.start);

    // Madrid is UTC+1 in January, Mexico City UTC-6: a seven-hour gap.
    const madridOffset = offsetMsAt(new Date(madridSlot.start), MADRID);
    const mexicoOffset = offsetMsAt(new Date(mexicoSlot.start), MEXICO_CITY);
    expect(madridOffset).toBe(60 * 60 * 1000);
    expect(mexicoOffset).toBe(-6 * 60 * 60 * 1000);
  });

  // A23 — normalisation canonicalizes to UTC while keeping the zone
  it('normalises window bounds to UTC and retains the requested zone', () => {
    const validation = validateQuery(
      winterQuery({ timeZone: MEXICO_CITY })
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error('unreachable');
    expect(validation.normalized.startUtc).toBe('2026-01-15T00:00:00.000Z');
    expect(validation.normalized.timeZone).toBe(MEXICO_CITY);
  });

  // A24 — a DST transition shifts the offset, and the mock must follow it
  it('resolves local hours correctly across a DST transition', async () => {
    const provider = new MockCalendarAvailabilityProvider({ hours: [12] });
    const service = new AvailabilityService(provider);

    // Europe/Madrid springs forward on 2026-03-29.
    const before = await service.findAvailability({
      window: {
        start: '2026-03-27T00:00:00.000Z',
        end: '2026-03-29T00:00:00.000Z',
      },
      durationMinutes: 60,
      timeZone: MADRID,
      calendarId: 'cal-1',
    });

    const after = await service.findAvailability({
      window: {
        start: '2026-03-29T00:00:00.000Z',
        end: '2026-03-31T00:00:00.000Z',
      },
      durationMinutes: 60,
      timeZone: MADRID,
      calendarId: 'cal-1',
    });

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error('unreachable');

    const slotBefore = before.slots[0];
    const slotAfter = after.slots[0];
    expect(slotBefore).toBeDefined();
    expect(slotAfter).toBeDefined();

    // CET (UTC+1) before the change, CEST (UTC+2) after: 12:00 local is
    // 11:00Z and 10:00Z respectively.
    expect(offsetMsAt(new Date(slotBefore.start), MADRID)).toBe(60 * 60 * 1000);
    expect(offsetMsAt(new Date(slotAfter.start), MADRID)).toBe(2 * 60 * 60 * 1000);
  });
});

describe('availability — determinism, ordering and containment', () => {
  // A25 — identical requests give identical answers
  it('is deterministic and idempotent for an identical query', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [9, 11, 13] })
    );

    const first = await service.findAvailability(winterQuery());
    const second = await service.findAvailability(winterQuery());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.slots).toEqual(first.slots);
  });

  // A26
  it('returns slots in ascending start order', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [15, 9, 12] })
    );

    const result = await service.findAvailability(winterQuery());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const starts = result.slots.map((s) => s.start);
    expect(starts).toEqual([...starts].sort());
  });

  // A27 — a provider answering a wider question must not widen our answer
  it('drops slots outside the requested window', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [10], overflow: 3 })
    );

    const result = await service.findAvailability(winterQuery());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const windowEnd = new Date('2026-01-16T00:00:00.000Z').getTime();
    for (const slot of result.slots) {
      expect(new Date(slot.end).getTime()).toBeLessThanOrEqual(windowEnd);
    }
  });

  // A28 — wrong-length slots are not answers to this question
  it('drops slots whose duration is not the requested duration', async () => {
    const provider = new MockCalendarAvailabilityProvider({ hours: [10] });
    const service = new AvailabilityService(provider);

    const result = await service.findAvailability(
      winterQuery({ durationMinutes: 30 })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    for (const slot of result.slots) {
      expect(
        new Date(slot.end).getTime() - new Date(slot.start).getTime()
      ).toBe(30 * 60 * 1000);
    }
  });

  // A29
  it('honours the requested limit', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [9, 10, 11, 12] })
    );

    const result = await service.findAvailability(winterQuery({ limit: 2 }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots).toHaveLength(2);
  });

  // A30 — the audit seam records outcomes without affecting them
  it('reports each outcome to the observer', async () => {
    const events: string[] = [];
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({
        behaviour: [MockBehaviour.OUTAGE, MockBehaviour.EMPTY],
      }),
      { observer: { onRead: (e) => events.push(e.outcome) } }
    );

    await service.findAvailability(winterQuery());
    await service.findAvailability(winterQuery());
    await service.findAvailability(
      winterQuery({ window: { start: 'bad', end: 'worse' } })
    );

    expect(events).toEqual(['provider_failed', 'ok', 'invalid_request']);
  });

  // A31 — a broken audit sink must not break the customer's answer
  it('survives an observer that throws', async () => {
    const service = new AvailabilityService(
      new MockCalendarAvailabilityProvider({ hours: [10] }),
      {
        observer: {
          onRead: () => {
            throw new Error('audit sink is down');
          },
        },
      }
    );

    const result = await service.findAvailability(winterQuery());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.slots.length).toBeGreaterThan(0);
  });
});
