/**
 * The read-only calendar availability contract.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, AND WHY IT ONLY READS
 * ============================================================================
 *
 * Blueprint v1.4 §19.2/§21.2 asks for appointments and service bookings, and
 * the one rule that governs every part of it is: never invent availability.
 * A model that produces a plausible time is not a scheduling system; it is a
 * promise the business has not made and cannot keep. The customer arrives to
 * a closed door.
 *
 * So the type system carries that rule rather than a comment asking nicely:
 *
 *   1. `CalendarAvailabilityProvider` exposes exactly one method, and it
 *      reads. There is no `createEvent`, no `book`, no `confirm`. A slice
 *      that cannot write cannot double-book, and cannot claim a booking it
 *      did not make. This is deliberate, not an omission: booking creation is
 *      a separate, later, provider-authoritative operation with its own
 *      idempotency contract.
 *
 *   2. Every slot a provider returns is `SlotProvenance.AUTHORITATIVE`. A
 *      caller cannot construct a slot from nothing and have it typecheck,
 *      because the only constructor-like path is through the service, which
 *      stamps provenance from the provider's own answer.
 *
 *   3. `SlotConfirmation.SUGGESTED` is the only value any type in this
 *      package produces. `CONFIRMED` exists so that a later booking slice can
 *      express it, and so that consumers can switch exhaustively over both —
 *      but nothing here can mint one. The distinction is load-bearing:
 *      "here are the times we could offer" and "you are booked" are different
 *      statements, and conflating them is how a system lies to a customer.
 */

/** IANA time zone identifier, e.g. `Europe/Madrid`. Not a UTC offset. */
export type TimeZoneId = string;

/**
 * A closed-open instant range, `[start, end)`, as ISO-8601 UTC strings.
 *
 * Closed-open because adjacent windows must not overlap at the boundary: a
 * query for 09:00-10:00 and one for 10:00-11:00 must not both claim 10:00.
 */
export interface InstantRange {
  /** Inclusive start, ISO-8601 with `Z` offset. */
  readonly start: string;
  /** Exclusive end, ISO-8601 with `Z` offset. */
  readonly end: string;
}

/**
 * Where a slot came from. Only `AUTHORITATIVE` is ever produced by this
 * package; the union exists so a future cache can label itself honestly
 * instead of being silently indistinguishable from live provider data.
 */
export enum SlotProvenance {
  /** Returned by the provider for this request. Trustworthy now. */
  AUTHORITATIVE = 'AUTHORITATIVE',
  /** Served from a cache. May be stale; label it and say when. */
  CACHED = 'CACHED',
}

/**
 * How strongly the system asserts a slot is held.
 *
 * `SUGGESTED` — the provider says this time is free. Nobody holds it, and it
 * can be taken between this answer and any later attempt to claim it.
 * `CONFIRMED` — the provider has recorded the booking. Only a write path can
 * produce this, and no write path exists in this package.
 */
export enum SlotConfirmation {
  SUGGESTED = 'SUGGESTED',
  CONFIRMED = 'CONFIRMED',
}

/** A single bookable interval, as returned by an authoritative provider. */
export interface AvailabilitySlot {
  readonly start: string;
  readonly end: string;
  /**
   * The zone the slot was computed in. Rendered to the customer in their own
   * zone, but retained so the business's calendar and the customer's
   * expectation can be reconciled when they differ.
   */
  readonly timeZone: TimeZoneId;
  readonly provenance: SlotProvenance;
  readonly confirmation: SlotConfirmation;
  /** Which provider and which of its calendars answered. */
  readonly source: AvailabilitySource;
}

export interface AvailabilitySource {
  /** Provider key, e.g. `mock`. Never a display name. */
  readonly provider: string;
  /** Opaque provider-side calendar/booking-page identifier. */
  readonly calendarId: string;
}

/**
 * A request for availability. Note what is absent: no organization secret, no
 * access token. Credentials are bound to the provider instance by construction
 * so that they cannot travel through request data, logs or queues.
 */
export interface AvailabilityQuery {
  /** Window to look in, in UTC. */
  readonly window: InstantRange;
  /** Length of each candidate appointment. Must be a positive whole minute. */
  readonly durationMinutes: number;
  /** Zone in which the business defines its working hours. */
  readonly timeZone: TimeZoneId;
  /** Provider-side calendar/booking-page identifier. */
  readonly calendarId: string;
  /** Upper bound on returned slots. */
  readonly limit?: number;
}

/**
 * Why a provider could not answer.
 *
 * These are distinct because they demand different handling: `UNAVAILABLE` is
 * a retry, `NOT_CONFIGURED` is a setup task, `INVALID_REQUEST` is a bug. All
 * of them end the same way in this slice — no slots — but the caller is told
 * which one happened so it can say something true to the operator.
 */
export enum AvailabilityFailureReason {
  /** Provider unreachable, timed out, or returned a server error. */
  UNAVAILABLE = 'UNAVAILABLE',
  /** Provider answered, but rejected our credentials or scope. */
  NOT_AUTHORIZED = 'NOT_AUTHORIZED',
  /** No calendar/credentials configured for this organization yet. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** The request itself was malformed. */
  INVALID_REQUEST = 'INVALID_REQUEST',
  /** Provider answered in a shape we cannot trust. */
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
}

/** The result of asking a provider for availability. */
export type AvailabilityResult =
  | {
      readonly ok: true;
      readonly slots: readonly AvailabilitySlot[];
      /** Provider-reported instant, so a caller can gauge staleness. */
      readonly fetchedAt: string;
    }
  | {
      readonly ok: false;
      readonly reason: AvailabilityFailureReason;
      /** Operator-facing detail. Never shown to a customer verbatim. */
      readonly detail: string;
      /**
       * Always empty. Present as a field so that callers which iterate
       * results without branching on `ok` still cannot fabricate a booking
       * out of a failure.
       */
      readonly slots: readonly [];
    };

/**
 * A read-only availability provider.
 *
 * Implementations must not write to the underlying calendar. Returning slots
 * that the provider did not report is the one failure this design exists to
 * prevent; a provider that would have to guess must return
 * `AvailabilityFailureReason.UNAVAILABLE` instead.
 */
export interface CalendarAvailabilityProvider {
  /** Stable key, matched against `AvailabilitySource.provider`. */
  readonly key: string;
  /**
   * The provider's own answer for a window. Implementations must:
   *
   *   - return only intervals the provider actually reported;
   *   - resolve every failure into a typed `AvailabilityFailureReason`
   *     rather than throwing, so one flaky calendar cannot take down a
   *     conversation loop;
   *   - never widen the requested window to "find something".
   */
  findAvailability(query: AvailabilityQuery): Promise<AvailabilityResult>;
}
