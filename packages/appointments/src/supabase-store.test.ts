/**
 * Supabase store — DB1…DB14.
 *
 * Everything goes through a fake of the PostgREST surface (`SupabaseQueryLike`),
 * so no test needs a database, credentials, or the network. The fake
 * reproduces the semantics the store depends on: unique-violation codes on
 * the idempotency index, foreign-key codes for unknown requests, single()
 * failing when nothing matched, and upsert-deduplication. The database-level
 * truth for the same invariants is the pgTAP suite
 * (`supabase/tests/database/appointment_requests.test.sql`).
 */

import { describe, it, expect } from 'vitest';
import {
  SupabaseAppointmentStore,
  type SupabaseClientLike,
  type SupabaseQueryLike,
  type SupabaseResultLike,
} from './index.js';
import {
  AppointmentRequestStatus,
  AvailabilityFailureReason,
  DEFAULT_SUGGESTION_TTL_MS,
  AppointmentSuggestionStatus,
  SlotConfirmation,
  SlotProvenance,
  type AvailabilitySlot,
} from './index.js';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const ORG = 'org-1';
const CAL = 'cal-1';

interface FakeError {
  code?: string;
  message: string;
  details?: string;
}

type Row = Record<string, unknown>;

/**
 * Minimal PostgREST semantics: eq filters, ordering, single/maybeSingle
 * cardinality, unique/FK violation codes, upsert dedupe, and error
 * injection. Deterministic ids and clock so assertions are exact.
 */
class FakeSupabaseClient implements SupabaseClientLike {
  readonly tables = new Map<string, Row[]>([
    ['appointment_requests', []],
    ['appointment_suggestions', []],
    ['organizations', []],
  ]);
  /** Next query against `table` fails with this error, then the flag clears. */
  readonly failNext = new Map<string, FakeError>();
  /** Simulate the idempotency race: the next request lookup misses once. */
  raceNextLookup = false;
  private idSeq = 0;

  from(table: string): SupabaseQueryLike {
    return new FakeQuery(this, table);
  }

  nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}-${this.idSeq}`;
  }

  timestamp(): string {
    return new Date(NOW).toISOString();
  }
}

class FakeQuery implements SupabaseQueryLike {
  private op: 'none' | 'insert' | 'upsert' | 'update' | 'read' = 'none';
  private payload: Row[] = [];
  private updateValues: Row = {};
  private upsertOptions: { onConflict: string; ignoreDuplicates: boolean } = {
    onConflict: '',
    ignoreDuplicates: false,
  };
  private filters: Array<[string, unknown]> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;

  constructor(
    private readonly client: FakeSupabaseClient,
    private readonly table: string
  ) {}

  insert(rows: readonly Record<string, unknown>[]): SupabaseQueryLike {
    this.op = 'insert';
    this.payload = rows.map((r) => ({ ...r }));
    return this;
  }

  upsert(
    rows: readonly Record<string, unknown>[],
    options: { onConflict: string; ignoreDuplicates: boolean }
  ): SupabaseQueryLike {
    this.op = 'upsert';
    this.payload = rows.map((r) => ({ ...r }));
    this.upsertOptions = options;
    return this;
  }

  update(values: Record<string, unknown>): SupabaseQueryLike {
    this.op = 'update';
    this.updateValues = { ...values };
    return this;
  }

  select(): SupabaseQueryLike {
    if (this.op === 'none') this.op = 'read';
    return this;
  }

  eq(column: string, value: unknown): SupabaseQueryLike {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options: { ascending: boolean }): SupabaseQueryLike {
    this.orderBy = { column, ascending: options.ascending };
    return this;
  }

  async single(): Promise<SupabaseResultLike> {
    const result = this.execute();
    if (result.error !== null) return result;
    const rows = result.data as Row[];
    if (rows.length !== 1) {
      return {
        data: null,
        error: {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
        status: 406,
      };
    }
    return { data: rows[0], error: null, status: 200 };
  }

  async maybeSingle(): Promise<SupabaseResultLike> {
    const result = this.execute();
    if (result.error !== null) return result;
    const rows = result.data as Row[];
    return { data: rows.length === 1 ? rows[0] : null, error: null, status: 200 };
  }

  then<TResult1 = SupabaseResultLike, TResult2 = never>(
    onfulfilled?: ((value: SupabaseResultLike) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled) as PromiseLike<
      TResult1 | TResult2
    >;
  }

  private execute(): SupabaseResultLike<Row[]> {
    const injected = this.client.failNext.get(this.table);
    if (injected !== undefined) {
      this.client.failNext.delete(this.table);
      return { data: null, error: injected, status: 400 };
    }

    const table = this.client.tables.get(this.table) ?? [];

    switch (this.op) {
      case 'insert':
        return this.doInsert(table);
      case 'upsert':
        return this.doUpsert(table);
      case 'update': {
        const matched = table.filter((r) => this.matches(r));
        for (const row of matched) Object.assign(row, this.updateValues);
        return { data: matched, error: null, status: 200 };
      }
      case 'read':
      case 'none': {
        if (
          this.table === 'appointment_requests' &&
          this.client.raceNextLookup
        ) {
          this.client.raceNextLookup = false;
          return { data: [], error: null, status: 200 };
        }
        const matched = table.filter((r) => this.matches(r));
        return { data: this.ordered(matched), error: null, status: 200 };
      }
    }
  }

  private doInsert(table: Row[]): SupabaseResultLike<Row[]> {
    if (this.table === 'appointment_requests') {
      for (const row of this.payload) {
        const clash = table.some(
          (r) =>
            r['organization_id'] === row['organization_id'] &&
            r['idempotency_key'] === row['idempotency_key']
        );
        if (clash) {
          return {
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "uq_appointment_requests_org_idempotency"',
            },
            status: 409,
          };
        }
      }
    }
    if (this.table === 'appointment_suggestions') {
      const requests = this.client.tables.get('appointment_requests') ?? [];
      for (const row of this.payload) {
        const parent = requests.some((r) => r['id'] === row['appointment_request_id']);
        if (!parent) {
          return {
            data: null,
            error: {
              code: '23503',
              message:
                'insert or update on table "appointment_suggestions" violates foreign key constraint',
            },
            status: 409,
          };
        }
        const dup = table.some(
          (r) =>
            r['appointment_request_id'] === row['appointment_request_id'] &&
            r['slot_start'] === row['slot_start'] &&
            r['slot_end'] === row['slot_end']
        );
        if (dup) {
          return {
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "uq_appointment_suggestions_request_slot"',
            },
            status: 409,
          };
        }
      }
    }
    const inserted = this.payload.map((row) => this.withDefaults(row));
    table.push(...inserted);
    return { data: inserted, error: null, status: 201 };
  }

  private doUpsert(table: Row[]): SupabaseResultLike<Row[]> {
    const conflictCols = this.upsertOptions.onConflict
      .split(',')
      .map((c) => c.trim());
    const inserted: Row[] = [];
    for (const row of this.payload) {
      const clash = table.some((r) =>
        conflictCols.every((c) => r[c] === row[c])
      );
      if (clash && this.upsertOptions.ignoreDuplicates) continue;
      if (this.table === 'appointment_suggestions') {
        const requests = this.client.tables.get('appointment_requests') ?? [];
        if (!requests.some((r) => r['id'] === row['appointment_request_id'])) {
          return {
            data: null,
            error: {
              code: '23503',
              message: 'violates foreign key constraint',
            },
            status: 409,
          };
        }
      }
      const full = this.withDefaults(row);
      table.push(full);
      inserted.push(full);
    }
    return { data: inserted, error: null, status: 201 };
  }

  private withDefaults(row: Row): Row {
    // The real database returns NULL for omitted nullable columns; the fake
    // must too, or mappers that distinguish null from undefined drift from
    // production behaviour.
    const nullableDefaults: Row =
      this.table === 'appointment_requests'
        ? {
            contact_id: null,
            conversation_id: null,
            failure_reason: null,
            provider: null,
            calendar_id: null,
          }
        : { provider_slot_id: null, expires_at: null };
    return {
      id: this.client.nextId(
        this.table === 'appointment_requests' ? 'db-req' : 'db-sug'
      ),
      status:
        this.table === 'appointment_requests'
          ? 'PENDING'
          : 'SUGGESTED',
      created_at: this.client.timestamp(),
      updated_at: this.client.timestamp(),
      ...nullableDefaults,
      ...row,
    };
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private ordered(rows: Row[]): Row[] {
    if (this.orderBy === null) return rows;
    const { column, ascending } = this.orderBy;
    return [...rows].sort((a, b) => {
      const av = a[column] as number;
      const bv = b[column] as number;
      return ascending ? av - bv : bv - av;
    });
  }
}

function slot(start: string, end: string): AvailabilitySlot {
  return {
    start,
    end,
    timeZone: 'Europe/Madrid',
    provenance: SlotProvenance.AUTHORITATIVE,
    confirmation: SlotConfirmation.SUGGESTED,
    source: { provider: 'mock', calendarId: CAL },
  };
}

function requestInput(overrides: Record<string, unknown> = {}) {
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

describe('supabase store — recordRequest', () => {
  // DB1
  it('inserts a request and maps the wire row back', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    const record = await store.recordRequest(requestInput());

    expect(record.created).toBe(true);
    expect(record.id).toMatch(/^db-req-/);
    expect(record.organizationId).toBe(ORG);
    expect(record.idempotencyKey).toBe('msg-1001');
    expect(record.windowStart).toBe('2026-01-15T00:00:00.000Z');
    expect(record.durationMinutes).toBe(60);
    expect(record.timeZone).toBe('Europe/Madrid');
    expect(record.status).toBe(AppointmentRequestStatus.PENDING);
    expect(record.failureReason).toBeNull();
  });

  // DB2
  it('returns the first row on a repeated key, without touching insert', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    const first = await store.recordRequest(requestInput());
    const second = await store.recordRequest(requestInput());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  // DB3 — the race: the lookup misses, the insert collides, the re-read wins
  it('collapses a concurrent duplicate through the unique index, not an error', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    const first = await store.recordRequest(requestInput());

    // The second call's lookup misses (the row committed between our read
    // and insert); its insert then hits 23505 and must re-read, not throw.
    client.raceNextLookup = true;
    const second = await store.recordRequest(requestInput());

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(client.tables.get('appointment_requests')).toHaveLength(1);
  });
});

describe('supabase store — recordSuggestions', () => {
  // DB4
  it('persists slots with provenance, retrieval, and default TTL', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());

    const recorded = await store.recordSuggestions(req.id, ORG, [
      slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z'),
      slot('2026-01-15T11:00:00.000Z', '2026-01-15T12:00:00.000Z'),
    ], { retrievedAt: '2026-01-15T09:00:00.000Z' });

    expect(recorded).toHaveLength(2);
    expect(recorded[0].appointmentRequestId).toBe(req.id);
    expect(recorded[0].provider).toBe('mock');
    expect(recorded[0].calendarId).toBe(CAL);
    expect(recorded[0].status).toBe(AppointmentSuggestionStatus.SUGGESTED);
    expect(recorded[0].retrievedAt).toBe('2026-01-15T09:00:00.000Z');
    const retrieved = Date.parse('2026-01-15T09:00:00.000Z');
    const expiry = Date.parse(recorded[0].expiresAt as string);
    expect(expiry - retrieved).toBe(DEFAULT_SUGGESTION_TTL_MS);
    expect(recorded[0].ordinal).toBe(0);
    expect(recorded[1].ordinal).toBe(1);
  });

  // DB5 — the boundary check runs before any database call
  it('refuses a CONFIRMED suggestion before touching the database', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());
    const confirmed: AvailabilitySlot = {
      ...slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z'),
      confirmation: SlotConfirmation.CONFIRMED,
    };

    await expect(
      store.recordSuggestions(req.id, ORG, [confirmed], {
        retrievedAt: '2026-01-15T09:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'CONFIRMED_NOT_ALLOWED' });
    expect(client.tables.get('appointment_suggestions')).toHaveLength(0);
  });

  // DB6
  it('deduplicates a repeated slot across writes through the unique index', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());
    const once = slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z');

    const first = await store.recordSuggestions(req.id, ORG, [once], {
      retrievedAt: '2026-01-15T09:00:00.000Z',
    });
    const second = await store.recordSuggestions(req.id, ORG, [once], {
      retrievedAt: '2026-01-15T09:00:00.000Z',
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(client.tables.get('appointment_suggestions')).toHaveLength(1);
  });

  // DB15 — recording new suggestions moves the request out of PENDING,
  // matching InMemoryAppointmentStore; a pure-dedup replay must not flip.
  it('flips the request to SUGGESTED when it records new slots', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());

    await store.recordSuggestions(req.id, ORG, [
      slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z'),
    ], { retrievedAt: '2026-01-15T09:00:00.000Z' });

    const requests = client.tables.get('appointment_requests') as Array<Record<string, unknown>>;
    const stored = requests.find((r) => r.id === req.id);
    expect(stored?.status).toBe('SUGGESTED');
  });

  // DB7
  it('maps a missing request to REQUEST_NOT_FOUND', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    await expect(
      store.recordSuggestions('no-such-request', ORG, [
        slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z'),
      ], { retrievedAt: '2026-01-15T09:00:00.000Z' })
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
  });

  // DB8 — CHECK failures map by constraint name, the same refusal vocabulary
  it.each([
    [
      'appointment_suggestions_never_confirmed',
      'CONFIRMED_NOT_ALLOWED',
    ],
    [
      'appointment_suggestions_provider_present',
      'UNATTRIBUTED_SUGGESTION',
    ],
    [
      'appointment_suggestions_slot_ordered',
      'INVALID_SLOT_INTERVAL',
    ],
    [
      'appointment_suggestions_expiry_after_retrieval',
      'EXPIRY_BEFORE_RETRIEVAL',
    ],
    ['some_unknown_check', 'INVALID_SLOT_INTERVAL'],
  ])('maps check violation %s to %s', async (constraint, expected) => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());
    client.failNext.set('appointment_suggestions', {
      code: '23514',
      message: `new row for relation "appointment_suggestions" violates check constraint "${constraint}"`,
    });

    await expect(
      store.recordSuggestions(req.id, ORG, [
        slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z'),
      ], { retrievedAt: '2026-01-15T09:00:00.000Z' })
    ).rejects.toMatchObject({ code: expected });
  });
});

describe('supabase store — status, reads, and the trusted zone', () => {
  // DB9
  it('FAILED requires a reason; other statuses clear it', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());

    await expect(
      store.updateStatus(req.id, AppointmentRequestStatus.FAILED)
    ).rejects.toMatchObject({ code: 'INVALID_SLOT_INTERVAL' });

    const failed = await store.updateStatus(
      req.id,
      AppointmentRequestStatus.FAILED,
      AvailabilityFailureReason.UNAVAILABLE
    );
    expect(failed.status).toBe(AppointmentRequestStatus.FAILED);
    expect(failed.failureReason).toBe('UNAVAILABLE');

    const suggested = await store.updateStatus(
      req.id,
      AppointmentRequestStatus.SUGGESTED,
      AvailabilityFailureReason.UNAVAILABLE
    );
    expect(suggested.failureReason).toBeNull();
  });

  // DB10
  it('updating a missing request reports REQUEST_NOT_FOUND', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    await expect(
      store.updateStatus('no-such-request', AppointmentRequestStatus.FAILED, AvailabilityFailureReason.UNAVAILABLE)
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
  });

  // DB11
  it('getRequest returns null for an unknown id', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    await expect(store.getRequest('no-such-request')).resolves.toBeNull();
  });

  // DB12
  it('listSuggestions returns rows in ordinal order', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    const req = await store.recordRequest(requestInput());
    await store.recordSuggestions(req.id, ORG, [
      slot('2026-01-15T10:00:00.000Z', '2026-01-15T11:00:00.000Z'),
      slot('2026-01-15T11:00:00.000Z', '2026-01-15T12:00:00.000Z'),
    ], { retrievedAt: '2026-01-15T09:00:00.000Z' });

    const listed = await store.listSuggestions(req.id);
    expect(listed.map((s) => s.ordinal)).toEqual([0, 1]);
  });

  // DB13 — the trusted zone read
  it('reads the organization time zone, or null when unset', async () => {
    const client = new FakeSupabaseClient();
    client.tables.get('organizations')?.push(
      { id: 'org-1', name: 'Espiga', slug: 'espiga', time_zone: 'Europe/Madrid' },
      { id: 'org-2', name: 'Tornillo', slug: 'tornillo', time_zone: null }
    );
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });

    await expect(store.getOrganizationTimeZone('org-1')).resolves.toBe('Europe/Madrid');
    await expect(store.getOrganizationTimeZone('org-2')).resolves.toBeNull();
    await expect(store.getOrganizationTimeZone('org-9')).resolves.toBeNull();
  });

  // DB14 — an unmapped database error is a typed failure, not a raw crash
  it('maps an unexpected database error to DATABASE_ERROR', async () => {
    const client = new FakeSupabaseClient();
    const store = new SupabaseAppointmentStore({ client, now: () => NOW });
    client.failNext.set('appointment_requests', {
      code: '08006',
      message: 'connection failure',
    });

    await expect(
      store.recordRequest(requestInput())
    ).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
      name: 'AppointmentStoreError',
    });
  });
});
