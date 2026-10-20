/**
 * Feature gates — FG1…FG5.
 *
 * The property under test is asymmetry: only an explicit enabled row turns
 * the integration on, and a broken flags read must fail closed. Everything
 * is stubbed; no database, no network beyond the fake fetch the provider
 * would use.
 */

import { describe, it, expect } from 'vitest';
import {
  createGoogleFreeBusyProvider,
  isGoogleFreeBusyEnabledForOrg,
  type FeatureFlagReader,
} from './index.js';
import {
  GOOGLE_FREEBUSY_FLAG_KEY,
  type FreeBusyFetch,
  type FreeBusyFetchResponse,
} from './index.js';
import type { AvailabilityQuery } from './provider.js';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');

function query(): AvailabilityQuery {
  return {
    window: {
      start: '2026-01-15T00:00:00.000Z',
      end: '2026-01-15T02:00:00.000Z',
    },
    durationMinutes: 60,
    timeZone: 'Europe/Madrid',
    calendarId: 'cal-google-1',
  };
}

class StubReader implements FeatureFlagReader {
  readonly calls: Array<{ organizationId: string; flagKey: string }> = [];
  rows = new Map<string, { isEnabled: boolean }>();
  throwOnRead = false;

  async readFlag(
    organizationId: string,
    flagKey: string
  ): Promise<{ isEnabled: boolean } | null> {
    this.calls.push({ organizationId, flagKey });
    if (this.throwOnRead) throw new Error('flags table unreachable');
    return this.rows.get(`${organizationId}|${flagKey}`) ?? null;
  }
}

class CountingFetch {
  calls = 0;
  readonly fetchFn: FreeBusyFetch = async () => {
    this.calls += 1;
    const response: FreeBusyFetchResponse = {
      status: 200,
      json: async () => ({ calendars: { 'cal-google-1': { busy: [] } } }),
    };
    return response;
  };
}

function buildProvider(
  reader: StubReader,
  fetch: CountingFetch,
  organizationId = 'org-1'
) {
  return createGoogleFreeBusyProvider({
    organizationId,
    flagReader: reader,
    getAccessToken: async () => 'tok',
    fetchFn: fetch.fetchFn,
    now: () => NOW,
  });
}

describe('feature gates — google freebusy per organization', () => {
  // FG1
  it('enables the provider only for an organization with an enabled row', async () => {
    const reader = new StubReader();
    reader.rows.set(`org-1|${GOOGLE_FREEBUSY_FLAG_KEY}`, { isEnabled: true });
    const fetch = new CountingFetch();

    const provider = await buildProvider(reader, fetch);
    const result = await provider.findAvailability(query());

    expect(result.ok).toBe(true);
    expect(fetch.calls).toBe(1);
  });

  // FG2
  it('leaves the provider off for a disabled row', async () => {
    const reader = new StubReader();
    reader.rows.set(`org-1|${GOOGLE_FREEBUSY_FLAG_KEY}`, { isEnabled: false });
    const fetch = new CountingFetch();

    const provider = await buildProvider(reader, fetch);
    const result = await provider.findAvailability(query());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('NOT_CONFIGURED');
    expect(fetch.calls).toBe(0);
  });

  // FG3 — unset is disabled: the default state of every organization
  it('treats a missing flag row as disabled', async () => {
    const reader = new StubReader();
    const fetch = new CountingFetch();

    const provider = await buildProvider(reader, fetch);
    const result = await provider.findAvailability(query());

    expect(result.ok).toBe(false);
    expect(fetch.calls).toBe(0);
    await expect(isGoogleFreeBusyEnabledForOrg(reader, 'org-2')).resolves.toBe(false);
  });

  // FG4 — gating failure must never enable the integration
  it('fails closed when the flag reader throws', async () => {
    const reader = new StubReader();
    reader.throwOnRead = true;
    const fetch = new CountingFetch();

    await expect(isGoogleFreeBusyEnabledForOrg(reader, 'org-1')).resolves.toBe(false);
    const provider = await buildProvider(reader, fetch);
    const result = await provider.findAvailability(query());

    expect(result.ok).toBe(false);
    expect(fetch.calls).toBe(0);
  });

  // FG5 — the gate asks about exactly one (organization, key) pair
  it('queries the reader with the organization id and the freebusy flag key', async () => {
    const reader = new StubReader();

    await isGoogleFreeBusyEnabledForOrg(reader, 'org-42');

    expect(reader.calls).toEqual([
      { organizationId: 'org-42', flagKey: 'google_calendar_freebusy' },
    ]);
  });
});
