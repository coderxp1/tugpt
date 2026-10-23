/**
 * The slice-2 workflow: record a request, ask the provider, persist the answer.
 *
 * This is the smallest useful vertical slice on top of slice 1's contract. It
 * still cannot book anything — there is no write path to a calendar anywhere in
 * this package — but it records what happened, which is what makes the behaviour
 * auditable and a dispute settleable.
 *
 * Ordering matters and is deliberate:
 *
 *   1. Record the request FIRST, before consulting the provider. A request that
 *      is never recorded is a customer question with no trace, and if the
 *      process dies mid-call there is evidence it tried.
 *   2. Resolve the business time zone from trusted configuration. A caller
 *      cannot influence it.
 *   3. Ask the provider through `AvailabilityService`, so slice 1's guarantees
 *      (no invention, no CONFIRMED, window containment) still hold.
 *   4. Persist the slots on success; move the request to NO_AVAILABILITY when
 *      the provider answered with nothing, or FAILED when it could not answer.
 *
 * On failure the request is marked FAILED with the reason, and no suggestions
 * are written. There is no path here that produces a suggestion the provider
 * did not return.
 */

import { AvailabilityService } from './availability-service.js';
import {
  AppointmentRequestStatus,
  type AppointmentRequestRecord,
  type AppointmentStore,
  type AppointmentSuggestionRecord,
} from './persistence.js';
import type { AvailabilityFailureReason } from './provider.js';
import { resolveBusinessTimeZone, type OrganizationTimeZoneConfig } from './time-zone-config.js';
import { parseInstant, validateQuery } from './time.js';

export interface AppointmentsConfig {
  readonly store: AppointmentStore;
  readonly availability: AvailabilityService;
  /** Trusted zone configuration for this organization. */
  readonly timeZoneConfig: OrganizationTimeZoneConfig;
}

/** What the caller supplies. Note the absence of a time zone. */
export interface RequestAvailabilityInput {
  readonly organizationId: string;
  /**
   * Caller-supplied for collapse of retries. The caller must derive it
   * deterministically from the triggering event — a random value defeats the
   * mechanism while appearing to use it.
   */
  readonly idempotencyKey: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly durationMinutes: number;
  readonly calendarId: string;
  readonly contactId?: string | null;
  readonly conversationId?: string | null;
  /**
   * Advisory only. Recorded nowhere and used for nothing: it exists so a caller
   * can express the customer's zone without being tempted to put it in
   * `timeZoneConfig`. See `normalizePresentationTimeZone` for how it should be
   * used — rendering, not scheduling.
   */
  readonly customerTimeZoneHint?: string | null;
  readonly limit?: number;
}

export type RequestAvailabilityOutcome =
  | {
      readonly ok: true;
      readonly request: AppointmentRequestRecord;
      readonly suggestions: readonly AppointmentSuggestionRecord[];
    }
  | {
      readonly ok: false;
      readonly request: AppointmentRequestRecord;
      readonly reason: AvailabilityFailureReason;
      readonly detail: string;
    };

export class AppointmentsService {
  private readonly store: AppointmentStore;
  private readonly availability: AvailabilityService;
  private readonly timeZoneConfig: OrganizationTimeZoneConfig;

  constructor(config: AppointmentsConfig) {
    this.store = config.store;
    this.availability = config.availability;
    this.timeZoneConfig = config.timeZoneConfig;
  }

  /**
   * Record and answer one availability request.
   *
   * Resolves rather than rejects for provider and validation problems, so a
   * conversation loop cannot lose a turn. It DOES reject if the trusted time
   * zone cannot be resolved: that is a configuration fault an operator must
   * fix, and silently continuing would produce slots in the wrong zone.
   */
  async requestAvailability(
    input: RequestAvailabilityInput
  ): Promise<RequestAvailabilityOutcome> {
    // 1. Trusted zone. Throws TimeZoneResolutionError on misconfiguration.
    const resolved = resolveBusinessTimeZone(this.timeZoneConfig);

    // 2. Record the request before touching the provider.
    const request = await this.store.recordRequest({
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      durationMinutes: input.durationMinutes,
      timeZone: resolved.timeZone,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      provider: this.availability.providerKey,
      calendarId: input.calendarId,
    });

    // A repeat of a known request returns the first answer rather than asking
    // the provider again. Re-asking would be harmless but would write a second
    // set of suggestions for one customer question, which reads as two offers.
    if (!request.created) {
      const existing = await this.store.listSuggestions(request.id);
      if (existing.length > 0 || request.status !== AppointmentRequestStatus.PENDING) {
        if (request.status === AppointmentRequestStatus.FAILED) {
          return {
            ok: false,
            request,
            reason: request.failureReason ?? ('UNAVAILABLE' as AvailabilityFailureReason),
            detail: 'replayed a previously failed request',
          };
        }
        return { ok: true, request, suggestions: existing };
      }
    }

    // 3. Ask, through slice 1's validating service.
    const query = {
      window: { start: input.windowStart, end: input.windowEnd },
      durationMinutes: input.durationMinutes,
      // The RESOLVED zone, never the caller's or the customer's.
      timeZone: resolved.timeZone,
      calendarId: input.calendarId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    };

    const result = await this.availability.findAvailability(query);

    if (!result.ok) {
      const failed = await this.store.updateStatus(
        request.id,
        AppointmentRequestStatus.FAILED,
        result.reason
      );
      return { ok: false, request: failed, reason: result.reason, detail: result.detail };
    }

    if (result.slots.length === 0) {
      // The provider answered and nothing was free. That is success with an
      // empty result — not a failure, and not a reason to invent a slot.
      const closed = await this.store.updateStatus(
        request.id,
        AppointmentRequestStatus.NO_AVAILABILITY
      );
      return { ok: true, request: closed, suggestions: [] };
    }

    // 4. Persist what the provider actually returned.
    const suggestions = await this.store.recordSuggestions(
      request.id,
      input.organizationId,
      result.slots,
      { retrievedAt: result.fetchedAt }
    );

    const updated = await this.store.getRequest(request.id);
    return {
      ok: true,
      request: updated ?? request,
      suggestions,
    };
  }
}

/**
 * Is a recorded suggestion still worth restating to a customer?
 *
 * Availability is perishable. A suggestion past its expiry is not wrong, it is
 * UNKNOWN — the slot may since have been taken — and the honest action is to
 * ask the provider again rather than repeat a claim we can no longer support.
 *
 * A NULL expiry is treated as expired, not as valid forever: unknown must not
 * read as current.
 */
export function isSuggestionCurrent(
  suggestion: Pick<AppointmentSuggestionRecord, 'expiresAt'>,
  now: Date
): boolean {
  if (suggestion.expiresAt === null) return false;
  const expiry = parseInstant(suggestion.expiresAt);
  if (expiry === null) return false;
  return expiry.getTime() > now.getTime();
}

/**
 * The same question for a whole response, so a caller does not reimplement it.
 */
export function filterCurrentSuggestions(
  suggestions: readonly AppointmentSuggestionRecord[],
  now: Date
): AppointmentSuggestionRecord[] {
  return suggestions.filter((s) => isSuggestionCurrent(s, now));
}

export { validateQuery };
