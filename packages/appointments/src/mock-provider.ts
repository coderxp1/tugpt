/**
 * A deterministic availability provider for tests and local development.
 *
 * Determinism is the point. A mock that returns "some time next week" cannot
 * support a test asserting time-zone correctness, and a mock whose failure
 * mode is "the network was down that day" cannot support a test asserting we
 * return nothing on outage. So:
 *
 *   - the slots produced are a pure function of the request;
 *   - every failure mode the service must survive is an explicit, named
 *     switch rather than something simulated by patching a global.
 *
 * The generated slots sit on fixed clock hours inside the requested window so
 * that a test can assert exact instants without depending on when it ran.
 * Nothing here consults the real clock except to stamp `fetchedAt`.
 */

import {
  AvailabilityFailureReason,
  SlotConfirmation,
  SlotProvenance,
  type AvailabilityQuery,
  type AvailabilityResult,
  type AvailabilitySlot,
  type CalendarAvailabilityProvider,
} from './provider.js';
import { offsetMsAt, validateQuery } from './time.js';

/** How the mock should behave on this call. */
export enum MockBehaviour {
  /** Produce deterministic slots across the requested window. */
  AVAILABLE = 'AVAILABLE',
  /** Produce no slots. A legitimate answer: fully booked. */
  EMPTY = 'EMPTY',
  /** Report the provider as unreachable. */
  OUTAGE = 'OUTAGE',
  /** Report rejected credentials. */
  UNAUTHORIZED = 'UNAUTHORIZED',
  /** Report no calendar configured for this organization. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** Answer with a payload the service must refuse to trust. */
  MALFORMED = 'MALFORMED',
  /** Throw instead of returning, breaking the provider contract. */
  THROWS = 'THROWS',
}

export interface MockProviderOptions {
  /** Behaviour for the next call, or a sequence consumed one per call. */
  readonly behaviour?: MockBehaviour | readonly MockBehaviour[];
  /**
   * Local clock hours to place slots on, in the query's time zone.
   * Defaults to business hours.
   */
  readonly hours?: readonly number[];
  /** Step between consecutive slots, in minutes. Defaults to 60. */
  readonly stepMinutes?: number;
  /**
   * Number of slots to emit. By default, as many as fit in the window.
   * Set to exceed the window so a test can prove out-of-window slots are
   * dropped rather than returned.
   */
  readonly overflow?: number;
}

/** Business-hours default: 09:00-16:00 local, hourly. */
const DEFAULT_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

export class MockCalendarAvailabilityProvider implements CalendarAvailabilityProvider {
  readonly key = 'mock';

  private readonly behaviourSequence: readonly MockBehaviour[];
  private readonly hours: readonly number[];
  private readonly stepMinutes: number;
  private readonly overflow: number | undefined;

  private callCount = 0;

  constructor(options: MockProviderOptions = {}) {
    const behaviour = options.behaviour ?? MockBehaviour.AVAILABLE;
    this.behaviourSequence = Array.isArray(behaviour)
      ? behaviour
      : [behaviour as MockBehaviour];
    this.hours = options.hours ?? DEFAULT_HOURS;
    this.stepMinutes = options.stepMinutes ?? 60;
    this.overflow = options.overflow;
  }

  /** How many times `findAvailability` has been called. */
  get calls(): number {
    return this.callCount;
  }

  async findAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const index = this.callCount;
    this.callCount += 1;

    // A sequence shorter than the number of calls repeats its final entry,
    // so a test can say "fail once, then succeed forever" with two values.
    const behaviour =
      this.behaviourSequence[
        Math.min(index, this.behaviourSequence.length - 1)
      ] ?? MockBehaviour.AVAILABLE;

    const fetchedAt = new Date().toISOString();

    switch (behaviour) {
      case MockBehaviour.OUTAGE:
        return {
          ok: false,
          reason: AvailabilityFailureReason.UNAVAILABLE,
          detail: 'mock provider is simulating an outage',
          slots: [],
        };

      case MockBehaviour.UNAUTHORIZED:
        return {
          ok: false,
          reason: AvailabilityFailureReason.NOT_AUTHORIZED,
          detail: 'mock provider rejected the configured credentials',
          slots: [],
        };

      case MockBehaviour.NOT_CONFIGURED:
        return {
          ok: false,
          reason: AvailabilityFailureReason.NOT_CONFIGURED,
          detail: 'mock provider has no calendar configured for this organization',
          slots: [],
        };

      case MockBehaviour.THROWS:
        throw new Error('mock provider threw deliberately');

      case MockBehaviour.MALFORMED:
        return {
          ok: true,
          fetchedAt,
          // Slots that no correct provider would send: garbage instants,
          // an inverted range, and a wrong duration. The service must drop
          // all of them.
          slots: [
            {
              start: 'not-an-instant',
              end: 'also-not-an-instant',
              timeZone: query.timeZone,
              provenance: SlotProvenance.AUTHORITATIVE,
              confirmation: SlotConfirmation.SUGGESTED,
              source: { provider: this.key, calendarId: query.calendarId },
            },
            {
              start: '2026-01-01T10:00:00.000Z',
              end: '2026-01-01T09:00:00.000Z',
              timeZone: query.timeZone,
              provenance: SlotProvenance.AUTHORITATIVE,
              confirmation: SlotConfirmation.SUGGESTED,
              source: { provider: this.key, calendarId: query.calendarId },
            },
          ] as readonly AvailabilitySlot[],
        };

      case MockBehaviour.EMPTY:
        return { ok: true, slots: [], fetchedAt };

      case MockBehaviour.AVAILABLE:
      default:
        return {
          ok: true,
          slots: this.generate(query),
          fetchedAt,
        };
    }
  }

  /**
   * Deterministic slots on the configured local hours.
   *
   * Walks the requested window day by day in the query's time zone, emitting a
   * slot at each configured local hour whose instant lies inside the window.
   * Because the local hour is converted through `offsetMsAt`, the same
   * wall-clock hour on either side of a DST change yields different UTC
   * instants — which is exactly what the time-zone tests assert.
   */
  private generate(query: AvailabilityQuery): AvailabilitySlot[] {
    const validation = validateQuery(query);
    if (!validation.ok) return [];

    const { startUtc, endUtc, timeZone, durationMinutes, calendarId } =
      validation.normalized;

    const windowStart = new Date(startUtc);
    const windowEnd = new Date(endUtc);
    const durationMs = durationMinutes * 60_000;

    // Local calendar date of the window start, so the day walk begins on the
    // business's own date rather than the UTC one.
    const dayCursor = new Date(windowStart.getTime());
    const slots: AvailabilitySlot[] = [];

    // Hard bound on the walk: at most 32 days, matching the window ceiling.
    for (let day = 0; day < 32; day += 1) {
      for (const hour of this.hours) {
        const localMidnightUtc = this.localHourToInstant(
          dayCursor,
          hour,
          timeZone
        );
        if (localMidnightUtc === null) continue;

        const slotStart = localMidnightUtc.getTime();
        const slotEnd = slotStart + durationMs;

        if (slotStart < windowStart.getTime()) continue;
        if (slotEnd > windowEnd.getTime()) continue;

        slots.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
          timeZone,
          provenance: SlotProvenance.AUTHORITATIVE,
          confirmation: SlotConfirmation.SUGGESTED,
          source: { provider: this.key, calendarId },
        });
      }

      // Advance one local day. +24h is exact for a day walk because the
      // hour is re-resolved against the zone on each iteration.
      dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);

      if (dayCursor.getTime() > windowEnd.getTime() + 24 * 60 * 60 * 1000) {
        break;
      }
    }

    if (this.overflow !== undefined) {
      // Deliberately emit more than the window can hold, so the service's
      // window filter has something to reject.
      const extra: AvailabilitySlot[] = [];
      for (let i = 0; i < this.overflow; i += 1) {
        const start = windowEnd.getTime() + i * durationMs;
        extra.push({
          start: new Date(start).toISOString(),
          end: new Date(start + durationMs).toISOString(),
          timeZone,
          provenance: SlotProvenance.AUTHORITATIVE,
          confirmation: SlotConfirmation.SUGGESTED,
          source: { provider: this.key, calendarId },
        });
      }
      return [...slots, ...extra];
    }

    return slots;
  }

  /**
   * The UTC instant at which local `hour` occurs on `dayCursor`'s local date.
   *
   * Resolved by inverting the zone offset: take the naive UTC timestamp of the
   * local wall clock, subtract the offset that zone has near that moment, and
   * re-check once. The second pass matters on DST boundaries, where the offset
   * used for the first approximation is not the one in force at the result.
   */
  private localHourToInstant(
    dayCursor: Date,
    hour: number,
    timeZone: string
  ): Date | null {
    const y = dayCursor.getUTCFullYear();
    const m = dayCursor.getUTCMonth();
    const d = dayCursor.getUTCDate();

    // First approximation: treat the wall clock as if it were UTC.
    const naive = Date.UTC(y, m, d, hour, 0, 0, 0);

    const firstOffset = offsetMsAt(new Date(naive), timeZone);
    let candidate = naive - firstOffset;

    const secondOffset = offsetMsAt(new Date(candidate), timeZone);
    candidate = naive - secondOffset;

    const result = new Date(candidate);
    if (Number.isNaN(result.getTime())) return null;

    // A spring-forward gap means this local hour does not exist; skip it
    // rather than offering a time the business is not open.
    const roundTrip = offsetMsAt(result, timeZone);
    if (naive - roundTrip !== candidate) return null;

    return result;
  }
}
