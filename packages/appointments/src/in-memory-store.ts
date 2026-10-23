/**
 * In-memory implementation of `AppointmentStore`.
 *
 * Enforces the migration's invariants so that the logic is testable without a
 * database, and so a caller's mistake surfaces at the boundary rather than as a
 * Postgres error code. Not for production use: it holds state in a Map and
 * loses it on restart. The Supabase-backed store is the production one.
 */

import {
  AppointmentRequestStatus,
  AppointmentStoreError,
  AppointmentStoreErrorCode,
  AppointmentSuggestionStatus,
  DEFAULT_SUGGESTION_TTL_MS,
  assertPersistableSlot,
  type AppointmentRequestRecord,
  type AppointmentStore,
  type AppointmentSuggestionRecord,
  type NewAppointmentRequest,
} from './persistence.js';
import type { AvailabilityFailureReason, AvailabilitySlot } from './provider.js';

/** Deterministic ids, so a test can assert on them. */
function nextId(prefix: string, counter: number): string {
  return `${prefix}-${String(counter).padStart(6, '0')}`;
}

export interface InMemoryAppointmentStoreOptions {
  /** Fixed clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class InMemoryAppointmentStore implements AppointmentStore {
  private readonly requests = new Map<string, AppointmentRequestRecord>();
  /** `${organizationId}|${idempotencyKey}` -> request id */
  private readonly idempotency = new Map<string, string>();
  private readonly suggestions = new Map<string, AppointmentSuggestionRecord[]>();
  private readonly now: () => number;
  private requestCounter = 0;
  private suggestionCounter = 0;

  constructor(options: InMemoryAppointmentStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async recordRequest(
    input: NewAppointmentRequest
  ): Promise<AppointmentRequestRecord> {
    const scopedKey = `${input.organizationId}|${input.idempotencyKey}`;

    // Idempotent by construction: a repeat returns the first row.
    const existingId = this.idempotency.get(scopedKey);
    if (existingId !== undefined) {
      const existing = this.requests.get(existingId);
      if (existing !== undefined) {
        return { ...existing, created: false };
      }
    }

    const timestamp = new Date(this.now()).toISOString();
    this.requestCounter += 1;
    const record: AppointmentRequestRecord = {
      ...input,
      id: nextId('appt-req', this.requestCounter),
      status: AppointmentRequestStatus.PENDING,
      failureReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      created: true,
    };

    this.requests.set(record.id, record);
    this.idempotency.set(scopedKey, record.id);
    this.suggestions.set(record.id, []);
    return record;
  }

  async recordSuggestions(
    appointmentRequestId: string,
    organizationId: string,
    slots: readonly AvailabilitySlot[],
    options: { readonly retrievedAt: string; readonly expiresAt?: string | null }
  ): Promise<AppointmentSuggestionRecord[]> {
    const request = this.requests.get(appointmentRequestId);
    if (request === undefined) {
      throw new AppointmentStoreError(
        AppointmentStoreErrorCode.REQUEST_NOT_FOUND,
        `no appointment request '${appointmentRequestId}'`
      );
    }

    const expiresAt =
      options.expiresAt === undefined
        ? new Date(Date.parse(options.retrievedAt) + DEFAULT_SUGGESTION_TTL_MS).toISOString()
        : options.expiresAt;

    const existing = this.suggestions.get(appointmentRequestId) ?? [];
    const stored: AppointmentSuggestionRecord[] = [];
    // Intervals already committed OR accepted this call. Dedup must see both:
    // a provider that repeats a slot within one response is as wrong as one
    // that repeats it across two, and the unique index in the migration
    // rejects both.
    const seenIntervals = new Set(
      existing.map((s) => `${s.slotStart}|${s.slotEnd}`)
    );

    for (const [index, slot] of slots.entries()) {
      // Refuses CONFIRMED, unattributed slots, inverted intervals and bad
      // expiries — the same four things the migration's constraints refuse.
      assertPersistableSlot(slot, options.retrievedAt, expiresAt);

      const intervalKey = `${slot.start}|${slot.end}`;
      if (seenIntervals.has(intervalKey)) continue;
      seenIntervals.add(intervalKey);

      this.suggestionCounter += 1;
      const record: AppointmentSuggestionRecord = {
        id: nextId('appt-sug', this.suggestionCounter),
        appointmentRequestId,
        organizationId,
        slotStart: slot.start,
        slotEnd: slot.end,
        slotTimeZone: slot.timeZone,
        status: AppointmentSuggestionStatus.SUGGESTED,
        provider: slot.source.provider,
        calendarId: slot.source.calendarId,
        providerSlotId: null,
        retrievedAt: options.retrievedAt,
        expiresAt,
        ordinal: index,
        createdAt: new Date(this.now()).toISOString(),
      };
      stored.push(record);
    }

    this.suggestions.set(appointmentRequestId, [...existing, ...stored]);

    // Recording suggestions moves the request out of PENDING, matching what the
    // service does after a successful provider call.
    if (stored.length > 0) {
      const updated: AppointmentRequestRecord = {
        ...request,
        status: AppointmentRequestStatus.SUGGESTED,
        updatedAt: new Date(this.now()).toISOString(),
        created: false,
      };
      this.requests.set(appointmentRequestId, updated);
    }

    return stored;
  }

  async updateStatus(
    appointmentRequestId: string,
    status: AppointmentRequestStatus,
    failureReason: AvailabilityFailureReason | null = null
  ): Promise<AppointmentRequestRecord> {
    const request = this.requests.get(appointmentRequestId);
    if (request === undefined) {
      throw new AppointmentStoreError(
        AppointmentStoreErrorCode.REQUEST_NOT_FOUND,
        `no appointment request '${appointmentRequestId}'`
      );
    }

    // Mirrors appointment_requests_failure_reason_matches_status: FAILED must
    // say why, and a non-FAILED row must not carry a stale reason.
    const normalisedReason =
      status === AppointmentRequestStatus.FAILED ? failureReason : null;
    if (status === AppointmentRequestStatus.FAILED && normalisedReason === null) {
      throw new AppointmentStoreError(
        AppointmentStoreErrorCode.INVALID_SLOT_INTERVAL,
        'a FAILED request must record its failure reason'
      );
    }

    const updated: AppointmentRequestRecord = {
      ...request,
      status,
      failureReason: normalisedReason,
      updatedAt: new Date(this.now()).toISOString(),
      created: false,
    };
    this.requests.set(appointmentRequestId, updated);
    return updated;
  }

  async getRequest(id: string): Promise<AppointmentRequestRecord | null> {
    return this.requests.get(id) ?? null;
  }

  async listSuggestions(
    appointmentRequestId: string
  ): Promise<AppointmentSuggestionRecord[]> {
    return [...(this.suggestions.get(appointmentRequestId) ?? [])].sort(
      (a, b) => a.ordinal - b.ordinal
    );
  }
}
