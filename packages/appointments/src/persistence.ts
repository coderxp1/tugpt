/**
 * Persistence for appointment requests and suggestions.
 *
 * ============================================================================
 * WHY THE STORE IS AN INTERFACE
 * ============================================================================
 *
 * The schema exists (migration 20261019000001) but no database is reachable
 * from this worktree — Docker's daemon is not serving and there is no local
 * Postgres. Rather than leave the logic unverified, the persistence boundary is
 * an interface with two implementations:
 *
 *   - `InMemoryAppointmentStore`, tested here, which enforces the same
 *     invariants the database enforces;
 *   - a Supabase-backed store, to be added when a database is available and
 *     verified against the pgTAP suite in `supabase/tests/database`.
 *
 * The invariants are enforced in BOTH places on purpose. The database is the
 * authority — a CHECK constraint cannot be bypassed by a buggy caller — but a
 * store that only *relies* on the database turns every violation into a
 * round trip whose error message the caller must parse. Failing at the
 * boundary produces the error where the mistake is.
 *
 * ============================================================================
 * WHAT "IDEMPOTENT" MEANS HERE
 * ============================================================================
 *
 * Recording the same request twice returns the FIRST row, not an error. The
 * caller is a queue consumer: a redelivered message is normal, not exceptional,
 * and making it an error means every consumer needs retry-awareness that only
 * one of them will get right.
 *
 * The key is scoped per organization, matching the unique index in the
 * migration. Two businesses may use the same key.
 */

import type {
  AvailabilityFailureReason,
  AvailabilitySlot,
} from './provider.js';

/** Mirrors the `appointment_request_status` enum in the migration. */
export enum AppointmentRequestStatus {
  PENDING = 'PENDING',
  SUGGESTED = 'SUGGESTED',
  NO_AVAILABILITY = 'NO_AVAILABILITY',
  FAILED = 'FAILED',
  ABANDONED = 'ABANDONED',
}

/**
 * Mirrors `appointment_suggestion_status`.
 *
 * `CONFIRMED` is present so the type can express a future booking, and the
 * store refuses to persist it — exactly as the migration's CHECK constraint
 * does. Nothing in this slice can produce one.
 */
export enum AppointmentSuggestionStatus {
  SUGGESTED = 'SUGGESTED',
  CONFIRMED = 'CONFIRMED',
}

/** A request to record, before the store assigns identity and timestamps. */
export interface NewAppointmentRequest {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly durationMinutes: number;
  /**
   * The BUSINESS time zone. Trusted configuration — see `resolveBusinessTimeZone`.
   * Never a value taken from a customer message.
   */
  readonly timeZone: string;
  readonly contactId?: string | null;
  readonly conversationId?: string | null;
  readonly provider?: string | null;
  readonly calendarId?: string | null;
}

/** A request as stored. */
export interface AppointmentRequestRecord extends NewAppointmentRequest {
  readonly id: string;
  readonly status: AppointmentRequestStatus;
  readonly failureReason: AvailabilityFailureReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True when this call created the row; false when it returned a prior one. */
  readonly created: boolean;
}

/** A suggestion as stored. */
export interface AppointmentSuggestionRecord {
  readonly id: string;
  readonly appointmentRequestId: string;
  readonly organizationId: string;
  readonly slotStart: string;
  readonly slotEnd: string;
  readonly slotTimeZone: string;
  readonly status: AppointmentSuggestionStatus;
  readonly provider: string;
  readonly calendarId: string;
  readonly providerSlotId: string | null;
  readonly retrievedAt: string;
  readonly expiresAt: string | null;
  readonly ordinal: number;
  readonly createdAt: string;
}

/** Raised when a caller asks the store to persist something it must not. */
export class AppointmentStoreError extends Error {
  constructor(
    readonly code: AppointmentStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AppointmentStoreError';
  }
}

export enum AppointmentStoreErrorCode {
  /** A caller attempted to persist a CONFIRMED suggestion. */
  CONFIRMED_NOT_ALLOWED = 'CONFIRMED_NOT_ALLOWED',
  /** A suggestion was missing its provider attribution. */
  UNATTRIBUTED_SUGGESTION = 'UNATTRIBUTED_SUGGESTION',
  /** A suggestion had an invalid interval. */
  INVALID_SLOT_INTERVAL = 'INVALID_SLOT_INTERVAL',
  /** A suggestion's expiry preceded its retrieval. */
  EXPIRY_BEFORE_RETRIEVAL = 'EXPIRY_BEFORE_RETRIEVAL',
  /** An update targeted a request that does not exist. */
  REQUEST_NOT_FOUND = 'REQUEST_NOT_FOUND',
}

export interface AppointmentStore {
  /**
   * Record a request, or return the existing one for this
   * (organization, idempotencyKey) pair.
   */
  recordRequest(input: NewAppointmentRequest): Promise<AppointmentRequestRecord>;

  /** Persist the suggestions a provider returned for a request. */
  recordSuggestions(
    appointmentRequestId: string,
    organizationId: string,
    slots: readonly AvailabilitySlot[],
    options: { readonly retrievedAt: string; readonly expiresAt?: string | null }
  ): Promise<AppointmentSuggestionRecord[]>;

  /** Move a request to a terminal or intermediate state. */
  updateStatus(
    appointmentRequestId: string,
    status: AppointmentRequestStatus,
    failureReason?: AvailabilityFailureReason | null
  ): Promise<AppointmentRequestRecord>;

  /** Read one request by id. */
  getRequest(id: string): Promise<AppointmentRequestRecord | null>;

  /** Read the suggestions recorded for a request, in ordinal order. */
  listSuggestions(appointmentRequestId: string): Promise<AppointmentSuggestionRecord[]>;
}

/**
 * How long a recorded suggestion is considered trustworthy.
 *
 * Availability is perishable. Fifteen minutes is chosen to be shorter than a
 * typical customer exchange — long enough that the suggestion the customer is
 * looking at is still the one we can honour, short enough that we re-ask before
 * treating an old answer as current.
 *
 * This is a provisional value, not a measurement. It is exported so the number
 * appears in one place and can be justified or changed deliberately.
 */
export const DEFAULT_SUGGESTION_TTL_MS = 15 * 60 * 1000;

/**
 * Validate a suggestion before it is persisted.
 *
 * The checks mirror the migration's constraints one for one, so a violation is
 * caught here with a typed error instead of arriving as a Postgres error code
 * the caller has to decode.
 */
export function assertPersistableSlot(
  slot: AvailabilitySlot,
  retrievedAt: string,
  expiresAt: string | null
): void {
  if (slot.confirmation === 'CONFIRMED') {
    throw new AppointmentStoreError(
      AppointmentStoreErrorCode.CONFIRMED_NOT_ALLOWED,
      'a suggestion may not be persisted as CONFIRMED: no booking path exists'
    );
  }

  if (typeof slot.source?.provider !== 'string' || slot.source.provider.trim() === '') {
    throw new AppointmentStoreError(
      AppointmentStoreErrorCode.UNATTRIBUTED_SUGGESTION,
      'a suggestion must name the provider that reported it'
    );
  }

  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    throw new AppointmentStoreError(
      AppointmentStoreErrorCode.INVALID_SLOT_INTERVAL,
      `suggestion interval is not a valid ordered range: ${slot.start} -> ${slot.end}`
    );
  }

  if (expiresAt !== null) {
    const expiry = Date.parse(expiresAt);
    const retrieved = Date.parse(retrievedAt);
    if (Number.isNaN(expiry) || Number.isNaN(retrieved) || expiry <= retrieved) {
      throw new AppointmentStoreError(
        AppointmentStoreErrorCode.EXPIRY_BEFORE_RETRIEVAL,
        'a suggestion expiry must be after the moment it was retrieved'
      );
    }
  }
}
