import { describe, it, expect } from 'vitest';
import {
  OutlookFreeBusyProvider,
  type OutlookFetch,
  type OutlookFetchInit,
  type OutlookFetchResponse,
} from './outlook-freebusy-provider.js';
import { SlotProvenance, SlotConfirmation, type AvailabilityQuery } from './provider.js';

const TOKEN = 'tok-secret';
const CAL = 'me';

function graphScheduleResponse(busy: Array<{ start: string; end: string }>): unknown {
  return {
    value: [
      {
        scheduleItems: busy.map((b) => ({
          start: { dateTime: b.start, timeZone: 'UTC' },
          end: { dateTime: b.end, timeZone: 'UTC' },
          status: 'busy',
        })),
      },
    ],
  };
}

function fakeFetch(body: unknown): OutlookFetch {
  return async (_url: string, _init: OutlookFetchInit): Promise<OutlookFetchResponse> => ({
    status: 200,
    json: async () => body,
  });
}

function query(): AvailabilityQuery {
  return {
    window: { start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T17:00:00.000Z' },
    durationMinutes: 60,
    timeZone: 'UTC',
    calendarId: CAL,
    limit: 20,
  };
}

describe('OutlookFreeBusyProvider', () => {
  it('computes free slots around a busy block', async () => {
    const provider = new OutlookFreeBusyProvider({
      enabled: true,
      getAccessToken: async () => TOKEN,
      fetchFn: fakeFetch(
        graphScheduleResponse([
          { start: '2026-11-20T12:00:00.0000000', end: '2026-11-20T13:00:00.0000000' },
        ]),
      ),
    });

    const result = await provider.findAvailability(query());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.length).toBe(7);
    expect(result.slots[0]).toMatchObject({
      start: '2026-11-20T09:00:00.000Z',
      end: '2026-11-20T10:00:00.000Z',
      provenance: SlotProvenance.AUTHORITATIVE,
      confirmation: SlotConfirmation.SUGGESTED,
    });
    // No slot may overlap the 12:00-13:00 busy block.
    const busyStart = Date.parse('2026-11-20T12:00:00.000Z');
    const busyEnd = Date.parse('2026-11-20T13:00:00.000Z');
    for (const slot of result.slots) {
      const s = Date.parse(slot.start);
      const e = Date.parse(slot.end);
      expect(s < busyEnd && e > busyStart).toBe(false);
    }
  });

  it('fails closed when no token is configured', async () => {
    const provider = new OutlookFreeBusyProvider({
      enabled: true,
      getAccessToken: async () => null,
      fetchFn: fakeFetch(graphScheduleResponse([])),
    });
    const result = await provider.findAvailability(query());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.slots).toEqual([]);
  });

  it('fails closed when disabled', async () => {
    const provider = new OutlookFreeBusyProvider({
      getAccessToken: async () => TOKEN,
      fetchFn: fakeFetch(graphScheduleResponse([])),
    });
    const result = await provider.findAvailability(query());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.slots).toEqual([]);
  });
});
