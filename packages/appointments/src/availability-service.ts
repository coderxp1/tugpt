/**
 * The availability service: validate, ask, normalise, and never invent.
 *
 * The provider is the only source of truth for what is free. This service's
 * job is to make the provider's answer safe to act on:
 *
 *   - a malformed request never reaches the provider at all;
 *   - a provider failure becomes an empty, typed result — not a plausible
 *     guess, and not an exception that a caller might swallow and paper over;
 *   - slots outside the requested window are dropped rather than clipped,
 *     because a clipped slot is a time the provider did not offer;
 *   - overlapping duplicates are collapsed, so one busy calendar reported
 *     twice does not read as two appointments;
 *   - everything returned is stamped `AUTHORITATIVE` + `SUGGESTED`.
 *
 * Nothing here writes. Nothing here confirms.
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
import {
  isWithinWindow,
  parseInstant,
  validateQuery,
  type NormalizedQuery,
} from './time.js';
import { recordAvailabilityRead, type AvailabilityObserver } from './observability.js';

/**
 * Default when the caller supplies no observer.
 *
 * The service reports through `recordAvailabilityRead`, which contains a
 * throwing observer, so this object only has to exist — it does not have to
 * defend itself.
 */
const NOOP_OBSERVER: AvailabilityObserver = { onRead: () => {} };

export interface AvailabilityServiceOptions {
  readonly observer?: AvailabilityObserver;
}

export class AvailabilityService {
  private readonly provider: CalendarAvailabilityProvider;
  private readonly observer: AvailabilityObserver;

  constructor(
    provider: CalendarAvailabilityProvider,
    options: AvailabilityServiceOptions = {}
  ) {
    this.provider = provider;
    this.observer = options.observer ?? NOOP_OBSERVER;
  }

  /**
   * The provider's stable key.
   *
   * Exposed so a caller recording a request can attribute it to a provider
   * without holding a reference to the provider itself — the store needs the
   * name, never the credentials or the instance.
   */
  get providerKey(): string {
    return this.provider.key;
  }

  /**
   * Ask the provider what is free in `query.window`.
   *
   * Resolves — never rejects — so a caller in a conversation loop cannot lose
   * a turn to an exception. A failure is reported as `ok: false` with an empty
   * slot list and a reason.
   */
  async findAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const validation = validateQuery(query);
    if (!validation.ok) {
      recordAvailabilityRead(this.observer, {
        outcome: 'invalid_request',
        provider: this.provider.key,
        reason: AvailabilityFailureReason.INVALID_REQUEST,
        detail: validation.detail,
      });
      return {
        ok: false,
        reason: AvailabilityFailureReason.INVALID_REQUEST,
        detail: validation.detail,
        slots: [],
      };
    }

    const normalized = validation.normalized;

    let raw: AvailabilityResult;
    try {
      raw = await this.provider.findAvailability(query);
    } catch (error) {
      // A provider that throws has broken its contract. Contain it: an
      // unexpected exception must not become an invented slot, and must not
      // escape into the caller's control flow.
      const detail =
        error instanceof Error ? error.message : 'provider threw a non-Error value';
      recordAvailabilityRead(this.observer, {
        outcome: 'provider_threw',
        provider: this.provider.key,
        reason: AvailabilityFailureReason.UNAVAILABLE,
        detail,
      });
      return {
        ok: false,
        reason: AvailabilityFailureReason.UNAVAILABLE,
        detail: `provider '${this.provider.key}' threw: ${detail}`,
        slots: [],
      };
    }

    if (!raw || raw.ok !== true) {
      const reason = raw?.reason ?? AvailabilityFailureReason.MALFORMED_RESPONSE;
      const detail = raw?.detail ?? 'provider returned no result';
      recordAvailabilityRead(this.observer, {
        outcome: 'provider_failed',
        provider: this.provider.key,
        reason,
        detail,
      });
      return { ok: false, reason, detail, slots: [] };
    }

    const { slots, dropped } = this.normalize(raw.slots, normalized);

    recordAvailabilityRead(this.observer, {
      outcome: 'ok',
      provider: this.provider.key,
      returned: slots.length,
      dropped,
    });

    return { ok: true, slots, fetchedAt: raw.fetchedAt };
  }

  /**
   * Filter, deduplicate and stamp the provider's slots.
   *
   * Returns what was kept and how much was discarded, so the drop is visible
   * in telemetry rather than silent. A large `dropped` count means a provider
   * is answering a different question than the one asked.
   */
  private normalize(
    incoming: readonly AvailabilitySlot[],
    query: NormalizedQuery
  ): { slots: AvailabilitySlot[]; dropped: number } {
    const windowStart = new Date(query.startUtc);
    const windowEnd = new Date(query.endUtc);
    const expectedMs = query.durationMinutes * 60_000;

    const kept: AvailabilitySlot[] = [];
    const seen = new Set<string>();
    let dropped = 0;

    for (const slot of Array.isArray(incoming) ? incoming : []) {
      const start = slot ? parseInstant(slot.start) : null;
      const end = slot ? parseInstant(slot.end) : null;

      if (start === null || end === null) {
        dropped += 1;
        continue;
      }

      if (!isWithinWindow(start, end, windowStart, windowEnd)) {
        dropped += 1;
        continue;
      }

      // A slot whose length is not the requested length is not an answer to
      // this question; admitting it would offer the customer the wrong
      // appointment length.
      if (end.getTime() - start.getTime() !== expectedMs) {
        dropped += 1;
        continue;
      }

      const key = `${start.toISOString()}|${end.toISOString()}`;
      if (seen.has(key)) {
        dropped += 1;
        continue;
      }
      seen.add(key);

      kept.push({
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone: slot.timeZone || query.timeZone,
        // Stamped, not inherited. A provider cannot talk its way into
        // CACHED, and more importantly cannot claim CONFIRMED here.
        provenance: SlotProvenance.AUTHORITATIVE,
        confirmation: SlotConfirmation.SUGGESTED,
        source: {
          provider: this.provider.key,
          calendarId: query.calendarId,
        },
      });
    }

    kept.sort((a, b) => a.start.localeCompare(b.start));

    if (kept.length > query.limit) {
      dropped += kept.length - query.limit;
      kept.length = query.limit;
    }

    return { slots: kept, dropped };
  }
}

export { recordAvailabilityRead };
