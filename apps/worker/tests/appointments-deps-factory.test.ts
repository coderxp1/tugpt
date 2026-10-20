/**
 * @file appointments-deps-factory.test.ts
 * @description Composition tests for the appointments slice in the worker:
 * the Supabase store, the is_feature_enabled gate, the Google free/busy
 * provider, the vault-backed token lifecycle, and the trusted organization
 * time zone — wired together and exercised through
 * `AppointmentsService.requestAvailability`.
 *
 * Everything is stubbed at the seams the factory exposes: a fake Supabase
 * client (RPC + the four tables this slice touches), real vault rows
 * (encrypted with a test key ring, so the factory's reads decrypt for
 * real), and a stub fetch routed by URL. No database, no network, no real
 * Google credential.
 *
 * The properties under test are the composition's promises:
 *   - the flag is off by default and an RPC failure is "off";
 *   - a missing, malformed, wrong-scope, or unrefreshable credential is
 *     NOT_CONFIGURED, with no provider call attempted;
 *   - an expired token refreshes once, the refreshed credential is written
 *     back to the vault, and the new token is what reaches Google;
 *   - the request row carries the organization's zone, never a default the
 *     caller picked, unless the organization has none configured.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  encodeBytea,
  encryptSecret,
  readOrganizationSecret,
  type KeyRing,
} from '@tugpt/security';
import {
  buildAppointmentsDeps,
  GOOGLE_TOKEN_URL,
  resolveFreeBusyTimeoutMs,
  resolveTokenSkewSeconds,
  type AppointmentsDepsOptions,
} from '../src/appointments-deps-factory';
import { GOOGLE_FREEBUSY_SCOPE, type FreeBusyFetch } from '@tugpt/appointments';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const ORG = 'org-1';
const CAL = 'cal-google-1';
const KEY_ID = 'org.v1';
const KEYS: KeyRing = new Map([[KEY_ID, randomBytes(32)]]);

type Row = Record<string, unknown>;

const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

class FetchStub {
  readonly calls: FetchCall[] = [];
  tokenStatus = 200;
  tokenBody: unknown = { access_token: 'refreshed-token', expires_in: 3600 };

  readonly fetchFn: FreeBusyFetch = async (url, init) => {
    this.calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url === GOOGLE_TOKEN_URL) {
      return { status: this.tokenStatus, json: async () => this.tokenBody };
    }
    return {
      status: 200,
      json: async () => ({ calendars: { [CAL]: { busy: [] } } }),
    };
  };

  count(urlPart: string): number {
    return this.calls.filter((c) => c.url.includes(urlPart)).length;
  }
}

/** Minimal Supabase surface for the composition: rpc + five tables. */
class FakeSupabase {
  flag: boolean | 'error' = false;
  orgSecrets: Row[] = [];
  platformSecrets: Row[] = [];
  organizations: Row[] = [{ id: ORG, time_zone: 'Europe/Madrid' }];
  requests: Row[] = [];
  suggestions: Row[] = [];
  private seq = 0;

  async rpc(fn: string, _args: unknown) {
    if (fn !== 'is_feature_enabled') throw new Error(`unexpected rpc ${fn}`);
    if (this.flag === 'error') return { data: null, error: { message: 'rpc down' } };
    return { data: this.flag, error: null };
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  table(name: string): Row[] {
    switch (name) {
      case 'organization_secrets':
        return this.orgSecrets;
      case 'platform_secrets':
        return this.platformSecrets;
      case 'organizations':
        return this.organizations;
      case 'appointment_requests':
        return this.requests;
      case 'appointment_suggestions':
        return this.suggestions;
      default:
        throw new Error(`unexpected table ${name}`);
    }
  }
}

class FakeQuery {
  private op: 'read' | 'insert' | 'upsert' | 'update' = 'read';
  private payload: Row[] = [];
  private updateValues: Row = {};
  private filters: Array<[string, unknown]> = [];

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string
  ) {}

  select(): FakeQuery {
    return this;
  }

  eq(column: string, value: unknown): FakeQuery {
    this.filters.push([column, value]);
    return this;
  }

  order(): FakeQuery {
    return this;
  }

  insert(rows: Row | readonly Row[]): FakeQuery {
    this.op = 'insert';
    const list = Array.isArray(rows) ? rows : [rows];
    this.payload = list.map((r) => ({ ...r }));
    return this;
  }

  upsert(rows: Row | readonly Row[]): FakeQuery {
    this.op = 'upsert';
    const list = Array.isArray(rows) ? rows : [rows];
    this.payload = list.map((r) => ({ ...r }));
    return this;
  }

  update(values: Row): FakeQuery {
    this.op = 'update';
    this.updateValues = { ...values };
    return this;
  }

  async single(): Promise<{ data: unknown; error: unknown; status: number }> {
    const rows = this.execute();
    if (rows.length !== 1) {
      return {
        data: null,
        error: { code: 'PGRST116', message: 'no rows' },
        status: 406,
      };
    }
    return { data: rows[0], error: null, status: 200 };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown; status: number }> {
    const rows = this.execute();
    return { data: rows.length === 1 ? rows[0] : null, error: null, status: 200 };
  }

  then<TResult1 = { data: unknown; error: unknown; status: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown; status: number }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({
      data: this.execute(),
      error: null,
      status: 200,
    }).then(onfulfilled) as PromiseLike<TResult1 | TResult2>;
  }

  private matches(row: Row): boolean {
    return this.filters.every(([c, v]) => row[c] === v);
  }

  private execute(): Row[] {
    const table = this.db.table(this.table);
    switch (this.op) {
      case 'insert': {
        const inserted = this.payload.map((row) => ({
          id: this.db.nextId(
            this.table === 'appointment_requests' ? 'req' : 'row'
          ),
          status: 'PENDING',
          created_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
          failure_reason: null,
          contact_id: null,
          conversation_id: null,
          provider: null,
          calendar_id: null,
          ...row,
        }));
        table.push(...inserted);
        return inserted;
      }
      case 'upsert': {
        if (this.table === 'organization_secrets') {
          const inserted: Row[] = [];
          for (const row of this.payload) {
            const idx = table.findIndex(
              (r) =>
                r['organization_id'] === row['organization_id'] &&
                r['provider'] === row['provider'] &&
                r['secret_name'] === row['secret_name']
            );
            const stored = { id: this.db.nextId('sec'), ...row };
            if (idx >= 0) table[idx] = stored;
            else table.push(stored);
            inserted.push(stored);
          }
          return inserted;
        }
        // appointment_suggestions: dedupe on (request, start, end)
        const inserted: Row[] = [];
        for (const row of this.payload) {
          const dup = table.some(
            (r) =>
              r['appointment_request_id'] === row['appointment_request_id'] &&
              r['slot_start'] === row['slot_start'] &&
              r['slot_end'] === row['slot_end']
          );
          if (dup) continue;
          const stored = {
            id: this.db.nextId('sug'),
            status: 'SUGGESTED',
            created_at: new Date(NOW).toISOString(),
            provider_slot_id: null,
            ...row,
          };
          table.push(stored);
          inserted.push(stored);
        }
        return inserted;
      }
      case 'update': {
        const matched = table.filter((r) => this.matches(r));
        for (const row of matched) Object.assign(row, this.updateValues);
        return matched;
      }
      case 'read':
        return table.filter((r) => this.matches(r));
    }
  }
}

function sealOrgSecret(
  credential: unknown,
  scopes: string[] = [GOOGLE_FREEBUSY_SCOPE]
): Row {
  const sealed = encryptSecret(
    JSON.stringify(credential),
    { organizationId: ORG, provider: 'google', secretName: 'calendar_oauth' },
    KEY_ID,
    KEYS
  );
  return {
    organization_id: ORG,
    provider: 'google',
    secret_name: 'calendar_oauth',
    algorithm: sealed.algorithm,
    key_id: sealed.keyId,
    iv: encodeBytea(sealed.iv),
    ciphertext: encodeBytea(sealed.ciphertext),
    auth_tag: encodeBytea(sealed.authTag),
    scopes,
    expires_at: '2026-01-15T13:00:00.000Z',
  };
}

function sealPlatformClient(): Row {
  const sealed = encryptSecret(
    JSON.stringify({ client_id: 'cid', client_secret: 'csecret' }),
    { organizationId: null, provider: 'google', secretName: 'oauth_client' },
    KEY_ID,
    KEYS
  );
  return {
    provider: 'google',
    secret_name: 'oauth_client',
    algorithm: sealed.algorithm,
    key_id: sealed.keyId,
    iv: encodeBytea(sealed.iv),
    ciphertext: encodeBytea(sealed.ciphertext),
    auth_tag: encodeBytea(sealed.authTag),
  };
}

function build(
  db: FakeSupabase,
  fetchStub: FetchStub,
  overrides: Partial<AppointmentsDepsOptions> = {}
) {
  return buildAppointmentsDeps(db as unknown as SupabaseClient, {
    env: {},
    fetchFn: fetchStub.fetchFn,
    now: () => NOW,
    keyRing: KEYS,
    writeKeyId: KEY_ID,
    platformDefaultTimeZone: 'UTC',
    ...overrides,
  });
}

function requestInput() {
  return {
    organizationId: ORG,
    idempotencyKey: 'msg-2001',
    windowStart: '2026-01-15T09:00:00.000Z',
    windowEnd: '2026-01-15T11:00:00.000Z',
    durationMinutes: 60,
    calendarId: CAL,
  };
}

describe('appointments composition — flag gating', () => {
  it('defaults to off: flag unset means NOT_CONFIGURED and no network', async () => {
    const db = new FakeSupabase();
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    expect(org.freeBusyEnabled).toBe(false);

    const outcome = await org.service.requestAvailability(requestInput());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('NOT_CONFIGURED');
    expect(fetchStub.calls).toHaveLength(0);
    // The request was still recorded, and closed as FAILED with the reason.
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0]['status']).toBe('FAILED');
    expect(db.requests[0]['failure_reason']).toBe('NOT_CONFIGURED');
  });

  it('treats an RPC failure as off, even with a valid credential stored', async () => {
    const db = new FakeSupabase();
    db.flag = 'error';
    db.orgSecrets.push(
      sealOrgSecret({
        access_token: 'fresh-token',
        refresh_token: 'rt',
        expires_at: '2026-01-15T13:00:00.000Z',
      })
    );
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(org.freeBusyEnabled).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe('appointments composition — credential lifecycle', () => {
  it('uses a fresh stored token directly and records the org zone on the request', async () => {
    const db = new FakeSupabase();
    db.flag = true;
    db.orgSecrets.push(
      sealOrgSecret({
        access_token: 'fresh-token',
        refresh_token: 'rt',
        expires_at: '2026-01-15T13:00:00.000Z',
      })
    );
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(outcome.ok).toBe(true);
    expect(fetchStub.count('oauth2.googleapis.com')).toBe(0);
    expect(fetchStub.count('freeBusy')).toBe(1);
    const freeBusyCall = fetchStub.calls.find((c) => c.url === FREEBUSY_URL);
    expect(freeBusyCall?.headers['Authorization']).toBe('Bearer fresh-token');
    expect(db.requests[0]['time_zone']).toBe('Europe/Madrid');
    expect(db.requests[0]['status']).toBe('SUGGESTED');
    expect(db.suggestions.length).toBeGreaterThan(0);
  });

  it('refreshes an expired token once, persists it, and sends the new token', async () => {
    const db = new FakeSupabase();
    db.flag = true;
    db.orgSecrets.push(
      sealOrgSecret({
        access_token: 'stale-token',
        refresh_token: 'rt-1',
        expires_at: '2026-01-15T11:00:00.000Z', // expired at NOW
      })
    );
    db.platformSecrets.push(sealPlatformClient());
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(outcome.ok).toBe(true);
    expect(fetchStub.count('oauth2.googleapis.com')).toBe(1);
    const tokenCall = fetchStub.calls.find((c) => c.url === GOOGLE_TOKEN_URL);
    expect(tokenCall?.body).toContain('grant_type=refresh_token');
    const freeBusyCall = fetchStub.calls.find((c) => c.url === FREEBUSY_URL);
    expect(freeBusyCall?.headers['Authorization']).toBe('Bearer refreshed-token');

    // The refreshed credential was written back to the vault and decrypts.
    const stored = await readOrganizationSecret(
      db as unknown as SupabaseClient,
      ORG,
      'google',
      'calendar_oauth',
      KEYS
    );
    const parsed = JSON.parse(stored.plaintext) as Record<string, unknown>;
    expect(parsed['access_token']).toBe('refreshed-token');
    expect(parsed['refresh_token']).toBe('rt-1');
    expect(stored.scopes).toEqual([GOOGLE_FREEBUSY_SCOPE]);
  });

  it('fails closed when the token is expired and there is no refresh token', async () => {
    const db = new FakeSupabase();
    db.flag = true;
    db.orgSecrets.push(
      sealOrgSecret({
        access_token: 'stale-token',
        expires_at: '2026-01-15T11:00:00.000Z',
      })
    );
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('NOT_CONFIGURED');
    expect(fetchStub.count('freeBusy')).toBe(0);
  });

  it('fails closed when the refresh is refused', async () => {
    const db = new FakeSupabase();
    db.flag = true;
    db.orgSecrets.push(
      sealOrgSecret({
        access_token: 'stale-token',
        refresh_token: 'rt-1',
        expires_at: '2026-01-15T11:00:00.000Z',
      })
    );
    db.platformSecrets.push(sealPlatformClient());
    const fetchStub = new FetchStub();
    fetchStub.tokenStatus = 400;
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(outcome.ok).toBe(false);
    expect(fetchStub.count('freeBusy')).toBe(0);
  });

  it('fails closed when no credential is stored for the organization', async () => {
    const db = new FakeSupabase();
    db.flag = true;
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('NOT_CONFIGURED');
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('refuses a credential that was not granted the free/busy scope, before any call', async () => {
    const db = new FakeSupabase();
    db.flag = true;
    db.orgSecrets.push(
      sealOrgSecret(
        {
          access_token: 'fresh-token',
          refresh_token: 'rt',
          expires_at: '2026-01-15T13:00:00.000Z',
        },
        ['https://www.googleapis.com/auth/calendar.readonly']
      )
    );
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    const outcome = await org.service.requestAvailability(requestInput());

    expect(outcome.ok).toBe(false);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe('appointments composition — trusted time zone', () => {
  it('falls back to the platform default when the organization has none', async () => {
    const db = new FakeSupabase();
    db.organizations = [{ id: ORG, time_zone: null }];
    const fetchStub = new FetchStub();
    const deps = build(db, fetchStub);

    const org = await deps.forOrganization(ORG);
    expect(org.timeZoneConfig.organizationTimeZone).toBeNull();
    await org.service.requestAvailability(requestInput());
    expect(db.requests[0]['time_zone']).toBe('UTC');
  });
});

describe('appointments composition — env resolution', () => {
  it('resolves timeouts and skew with malformed-value fallbacks', () => {
    expect(resolveFreeBusyTimeoutMs({})).toBe(10_000);
    expect(resolveFreeBusyTimeoutMs({ GOOGLE_FREEBUSY_TIMEOUT_MS: '2500' })).toBe(2500);
    expect(resolveFreeBusyTimeoutMs({ GOOGLE_FREEBUSY_TIMEOUT_MS: 'soon' })).toBe(10_000);
    expect(resolveFreeBusyTimeoutMs({ GOOGLE_FREEBUSY_TIMEOUT_MS: '-5' })).toBe(10_000);
    expect(resolveTokenSkewSeconds({})).toBe(60);
    expect(resolveTokenSkewSeconds({ GOOGLE_OAUTH_EXPIRY_SKEW_SECONDS: '0' })).toBe(0);
    expect(resolveTokenSkewSeconds({ GOOGLE_OAUTH_EXPIRY_SKEW_SECONDS: 'later' })).toBe(60);
  });
});
