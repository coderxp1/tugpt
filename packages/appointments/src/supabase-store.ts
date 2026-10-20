/**
 * The production `AppointmentStore`, backed by Supabase (PostgREST).
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE IMPLEMENTATION, NOT AN EXTENSION OF THE IN-MEMORY ONE
 * ============================================================================
 *
 * `InMemoryAppointmentStore` exists to test the logic; it loses its state on
 * restart and must never be used in production. This implementation holds the
 * same invariants against the real database (migration 20261019000001), and
 * the database is the authority: its CHECK constraints and unique indexes
 * refuse what a buggy caller gets past the boundary checks here.
 *
 * The invariants are enforced in BOTH places on purpose (see
 * `persistence.ts`): `assertPersistableSlot` runs before anything is sent, so
 * a violation surfaces as a typed `AppointmentStoreError` at the caller's
 * door, while the database refuses it again with a Postgres error code if the
 * caller somehow bypasses this file.
 *
 * ============================================================================
 * SERVICE ROLE, BY DESIGN
 * ============================================================================
 *
 * This store takes a **service_role** client. The migration's RLS grants
 * `authenticated` SELECT only and the worker writes — there is no write
 * policy for browser roles, and no screen in this slice creates rows from a
 * browser. Passing an `anon`/`authenticated` client here would silently
 * return empty reads (RLS) and fail writes; the constructor cannot verify
 * which role a client carries, so the requirement is stated in the type name
 * (`SupabaseServiceClientLike` is not a name — the header is) and again in
 * `SupabaseAppointmentStoreOptions`. A caller that needs per-user reads uses
 * PostgREST with the user's token directly, not this store.
 *
 * ============================================================================
 * DEPENDENCY-FREE BY SEAM
 * ============================================================================
 *
 * This package does not depend on `@supabase/supabase-js`. The client surface
 * is described structurally (`SupabaseClientLike`), and the real client's
 * PostgREST builder satisfies it, so the composition root passes the real
 * client with no adapter. The seam also keeps every test here offline:
 * `supabase-store.test.ts` uses an in-memory fake of the same surface.
 *
 * ============================================================================
 * IDEMPOTENCY UNDER RACE
 * ============================================================================
 *
 * `recordRequest` reads first (the common path: a redelivery finds its row),
 * then inserts. A concurrent pair can still both read-then-insert; the
 * migration's `UNIQUE (organization_id, idempotency_key)` collapses the
 * second insert with a 23505, which this store maps back into a re-read. The
 * caller always gets the first row, never an error it must interpret.
 */

import {
  AppointmentRequestStatus,
  AppointmentSuggestionStatus,
  AppointmentStoreError,
  AppointmentStoreErrorCode,
  DEFAULT_SUGGESTION_TTL_MS,
  assertPersistableSlot,
  type AppointmentRequestRecord,
  type AppointmentStore,
  type AppointmentSuggestionRecord,
  type NewAppointmentRequest,
} from './persistence.js';
import type {
  AvailabilityFailureReason,
  AvailabilitySlot,
} from './provider.js';

/** The PostgREST error surface this store reads. */
export interface SupabaseErrorLike {
  readonly code?: string | null;
  readonly message: string;
  readonly details?: string | null;
  readonly hint?: string | null;
}

export interface SupabaseResultLike<T = unknown> {
  readonly data: T | null;
  readonly error: SupabaseErrorLike | null;
  readonly status: number;
}

/**
 * Structural surface of the PostgREST query builder. The real
 * `@supabase/supabase-js` client satisfies this; tests use a fake.
 */
export interface SupabaseQueryLike {
  insert(rows: readonly Record<string, unknown>[]): SupabaseQueryLike;
  upsert(
    rows: readonly Record<string, unknown>[],
    options: { readonly onConflict: string; readonly ignoreDuplicates: boolean }
  ): SupabaseQueryLike;
  update(values: Record<string, unknown>): SupabaseQueryLike;
  select(columns?: string): SupabaseQueryLike;
  eq(column: string, value: unknown): SupabaseQueryLike;
  order(column: string, options: { readonly ascending: boolean }): SupabaseQueryLike;
  single(): Promise<SupabaseResultLike>;
  maybeSingle(): Promise<SupabaseResultLike>;
  then<TResult1 = SupabaseResultLike, TResult2 = never>(
    onfulfilled?:
      | ((value: SupabaseResultLike) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined
  ): PromiseLike<TResult1 | TResult2>;
}

export interface SupabaseClientLike {
  from(table: string): SupabaseQueryLike;
}

export interface SupabaseAppointmentStoreOptions {
  /**
   * A **service_role** Supabase client. RLS on these tables grants
   * `authenticated` SELECT only; a lesser role will fail writes and see
   * empty reads. The store cannot verify the role, so this is a
   * composition-time contract, stated here and in the file header.
   */
  readonly client: SupabaseClientLike;
  /** Fixed clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Wire shape of `public.appointment_requests`. */
interface AppointmentRequestRow {
  readonly id: string;
  readonly organization_id: string;
  readonly contact_id: string | null;
  readonly conversation_id: string | null;
  readonly window_start: string;
  readonly window_end: string;
  readonly duration_minutes: number;
  readonly time_zone: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly idempotency_key: string;
  readonly provider: string | null;
  readonly calendar_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Wire shape of `public.appointment_suggestions`. */
interface AppointmentSuggestionRow {
  readonly id: string;
  readonly appointment_request_id: string;
  readonly organization_id: string;
  readonly slot_start: string;
  readonly slot_end: string;
  readonly slot_time_zone: string;
  readonly status: string;
  readonly provider: string;
  readonly calendar_id: string;
  readonly provider_slot_id: string | null;
  readonly retrieved_at: string;
  readonly expires_at: string | null;
  readonly ordinal: number;
  readonly created_at: string;
}

/** Constraint name -> typed error, for CHECK failures on the suggestions table. */
function mapSuggestionCheckError(error: SupabaseErrorLike): AppointmentStoreError {
  const text = `${error.code ?? ''} ${error.message} ${error.details ?? ''} ${error.hint ?? ''}`;
  const code = text.includes('appointment_suggestions_never_confirmed')
    ? AppointmentStoreErrorCode.CONFIRMED_NOT_ALLOWED
    : text.includes('appointment_suggestions_provider_present')
      ? AppointmentStoreErrorCode.UNATTRIBUTED_SUGGESTION
      : text.includes('appointment_suggestions_slot_ordered')
        ? AppointmentStoreErrorCode.INVALID_SLOT_INTERVAL
        : text.includes('appointment_suggestions_expiry_after_retrieval')
          ? AppointmentStoreErrorCode.EXPIRY_BEFORE_RETRIEVAL
          : AppointmentStoreErrorCode.INVALID_SLOT_INTERVAL;
  return new AppointmentStoreError(
    code,
    `database refused the suggestion (${error.code ?? 'no code'}): ${error.message}`
  );
}

function isUniqueViolation(error: SupabaseErrorLike | null): boolean {
  return error !== null && error.code === '23505';
}

/** PostgREST's "no rows" for `.single()` — a missing row, not a failure. */
function isNoRows(error: SupabaseErrorLike | null): boolean {
  return error !== null && (error.code === 'PGRST116' || error.code === 'PGRST122');
}

export class SupabaseAppointmentStore implements AppointmentStore {
  private readonly client: SupabaseClientLike;
  private readonly now: () => number;

  constructor(options: SupabaseAppointmentStoreOptions) {
    this.client = options.client;
    this.now = options.now ?? (() => Date.now());
  }

  async recordRequest(
    input: NewAppointmentRequest
  ): Promise<AppointmentRequestRecord> {
    const existing = await this.findByIdempotencyKey(
      input.organizationId,
      input.idempotencyKey
    );
    if (existing !== null) {
      return { ...existing, created: false };
    }

    const payload: Record<string, unknown> = {
      organization_id: input.organizationId,
      contact_id: input.contactId ?? null,
      conversation_id: input.conversationId ?? null,
      window_start: input.windowStart,
      window_end: input.windowEnd,
      duration_minutes: input.durationMinutes,
      time_zone: input.timeZone,
      idempotency_key: input.idempotencyKey,
      provider: input.provider ?? null,
      calendar_id: input.calendarId ?? null,
    };

    const inserted = await this.client
      .from('appointment_requests')
      .insert([payload])
      .select('*')
      .single();

    if (inserted.error === null && inserted.data !== null) {
      return {
        ...this.mapRequestRow(inserted.data as AppointmentRequestRow),
        created: true,
      };
    }

    // A concurrent twin won the insert: the unique index collapsed it.
    // Re-read and return the first row rather than an error.
    if (isUniqueViolation(inserted.error)) {
      const winner = await this.findByIdempotencyKey(
        input.organizationId,
        input.idempotencyKey
      );
      if (winner !== null) {
        return { ...winner, created: false };
      }
    }

    throw this.databaseError(
      'recordRequest',
      inserted.error,
      'could not record the appointment request'
    );
  }

  async recordSuggestions(
    appointmentRequestId: string,
    organizationId: string,
    slots: readonly AvailabilitySlot[],
    options: { readonly retrievedAt: string; readonly expiresAt?: string | null }
  ): Promise<AppointmentSuggestionRecord[]> {
    const expiresAt =
      options.expiresAt === undefined
        ? new Date(Date.parse(options.retrievedAt) + DEFAULT_SUGGESTION_TTL_MS).toISOString()
        : options.expiresAt;

    // Boundary check first: a violation surfaces as a typed error here,
    // with the database's CHECK as the backstop.
    for (const slot of slots) {
      assertPersistableSlot(slot, options.retrievedAt, expiresAt);
    }

    const rows = slots.map((slot, index) => ({
      appointment_request_id: appointmentRequestId,
      organization_id: organizationId,
      slot_start: slot.start,
      slot_end: slot.end,
      slot_time_zone: slot.timeZone,
      provider: slot.source.provider,
      calendar_id: slot.source.calendarId,
      provider_slot_id: null,
      retrieved_at: options.retrievedAt,
      expires_at: expiresAt,
      ordinal: index,
    }));

    if (rows.length === 0) {
      return [];
    }

    // ON CONFLICT DO NOTHING on the migration's (request, start, end) index:
    // a provider repeating a slot must not read as two appointments, and a
    // retried write must not either.
    const written = await this.client
      .from('appointment_suggestions')
      .upsert(rows, {
        onConflict: 'appointment_request_id,slot_start,slot_end',
        ignoreDuplicates: true,
      })
      .select('*');

    if (written.error !== null) {
      if (written.error.code === '23503') {
        throw new AppointmentStoreError(
          AppointmentStoreErrorCode.REQUEST_NOT_FOUND,
          `no appointment request '${appointmentRequestId}'`
        );
      }
      if (written.error.code === '23514') {
        throw mapSuggestionCheckError(written.error);
      }
      throw this.databaseError(
        'recordSuggestions',
        written.error,
        'could not record the suggestions'
      );
    }

    const data = (written.data ?? []) as AppointmentSuggestionRow[];
    const inserted = data
      .map((row) => this.mapSuggestionRow(row))
      .sort((a, b) => a.ordinal - b.ordinal);

    // Recording suggestions moves the request out of PENDING — the same
    // transition InMemoryAppointmentStore performs, and the service relies
    // on it when it re-reads the request. Only flip when at least one row
    // was newly inserted: a pure-dedup replay must not touch updated_at.
    if (inserted.length > 0) {
      await this.updateStatus(
        appointmentRequestId,
        AppointmentRequestStatus.SUGGESTED
      );
    }

    return inserted;
  }

  async updateStatus(
    appointmentRequestId: string,
    status: AppointmentRequestStatus,
    failureReason: AvailabilityFailureReason | null = null
  ): Promise<AppointmentRequestRecord> {
    // Mirrors appointment_requests_failure_reason_matches_status: FAILED must
    // say why, and a non-FAILED row must not carry a stale reason.
    const normalisedReason =
      status === AppointmentRequestStatus.FAILED ? failureReason : null;
    if (
      status === AppointmentRequestStatus.FAILED &&
      normalisedReason === null
    ) {
      throw new AppointmentStoreError(
        AppointmentStoreErrorCode.INVALID_SLOT_INTERVAL,
        'a FAILED request must record its failure reason'
      );
    }

    const updated = await this.client
      .from('appointment_requests')
      .update({ status, failure_reason: normalisedReason })
      .eq('id', appointmentRequestId)
      .select('*')
      .single();

    if (updated.error !== null) {
      if (isNoRows(updated.error)) {
        throw new AppointmentStoreError(
          AppointmentStoreErrorCode.REQUEST_NOT_FOUND,
          `no appointment request '${appointmentRequestId}'`
        );
      }
      throw this.databaseError(
        'updateStatus',
        updated.error,
        'could not update the request status'
      );
    }

    return {
      ...this.mapRequestRow(updated.data as AppointmentRequestRow),
      created: false,
    };
  }

  async getRequest(id: string): Promise<AppointmentRequestRecord | null> {
    const found = await this.client
      .from('appointment_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (found.error !== null) {
      throw this.databaseError('getRequest', found.error, 'could not read the request');
    }
    if (found.data === null) {
      return null;
    }
    return {
      ...this.mapRequestRow(found.data as AppointmentRequestRow),
      created: false,
    };
  }

  async listSuggestions(
    appointmentRequestId: string
  ): Promise<AppointmentSuggestionRecord[]> {
    const listed = await this.client
      .from('appointment_suggestions')
      .select('*')
      .eq('appointment_request_id', appointmentRequestId)
      .order('ordinal', { ascending: true });

    if (listed.error !== null) {
      throw this.databaseError(
        'listSuggestions',
        listed.error,
        'could not read the suggestions'
      );
    }
    return ((listed.data ?? []) as AppointmentSuggestionRow[]).map((row) =>
      this.mapSuggestionRow(row)
    );
  }

  /**
   * The organization's trusted time zone (`organizations.time_zone`,
   * migration 20261019000002). NULL when unset — the caller resolves it
   * through `resolveBusinessTimeZone`, which falls back to the platform
   * default or fails loudly. A database error is NOT returned as NULL: an
   * outage must not masquerade as "not configured".
   */
  async getOrganizationTimeZone(
    organizationId: string
  ): Promise<string | null> {
    const found = await this.client
      .from('organizations')
      .select('time_zone')
      .eq('id', organizationId)
      .maybeSingle();

    if (found.error !== null) {
      throw this.databaseError(
        'getOrganizationTimeZone',
        found.error,
        'could not read the organization time zone'
      );
    }
    if (found.data === null) {
      return null;
    }
    const zone = (found.data as { time_zone?: string | null }).time_zone;
    return zone ?? null;
  }

  private async findByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string
  ): Promise<AppointmentRequestRecord | null> {
    const found = await this.client
      .from('appointment_requests')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (found.error !== null) {
      throw this.databaseError(
        'recordRequest',
        found.error,
        'could not look up the idempotency key'
      );
    }
    if (found.data === null) {
      return null;
    }
    return {
      ...this.mapRequestRow(found.data as AppointmentRequestRow),
      created: false,
    };
  }

  private mapRequestRow(row: AppointmentRequestRow): AppointmentRequestRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      durationMinutes: row.duration_minutes,
      timeZone: row.time_zone,
      status: row.status as AppointmentRequestStatus,
      failureReason: row.failure_reason as AvailabilityFailureReason | null,
      idempotencyKey: row.idempotency_key,
      provider: row.provider,
      calendarId: row.calendar_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      created: false,
    };
  }

  private mapSuggestionRow(row: AppointmentSuggestionRow): AppointmentSuggestionRecord {
    return {
      id: row.id,
      appointmentRequestId: row.appointment_request_id,
      organizationId: row.organization_id,
      slotStart: row.slot_start,
      slotEnd: row.slot_end,
      slotTimeZone: row.slot_time_zone,
      status: row.status as AppointmentSuggestionStatus,
      provider: row.provider,
      calendarId: row.calendar_id,
      providerSlotId: row.provider_slot_id,
      retrievedAt: row.retrieved_at,
      expiresAt: row.expires_at,
      ordinal: row.ordinal,
      createdAt: row.created_at,
    };
  }

  private databaseError(
    operation: string,
    error: SupabaseErrorLike | null,
    context: string
  ): AppointmentStoreError {
    return new AppointmentStoreError(
      AppointmentStoreErrorCode.DATABASE_ERROR,
      `supabase store '${operation}' failed: ${context} (${error?.code ?? 'no code'}): ${error?.message ?? 'unknown error'}`
    );
  }
}
