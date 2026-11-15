/**
 * Microsoft 365 free/busy provider â€” the Outlook/M365 counterpart of
 * GoogleFreeBusyProvider. Read-only: it answers "is this time occupied?" via
 * Microsoft Graph `getSchedule` and never creates, updates or deletes events.
 *
 * Least privilege: the composition root must request `Calendars.ReadBasic`
 * (free/busy only). The provider never sees event titles, attendees or bodies.
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
import { validateQuery } from './time.js';

export const OUTLOOK_FREEBUSY_PROVIDER_KEY = 'outlook-calendar';
export const OUTLOOK_FREEBUSY_SCOPE = 'Calendars.ReadBasic';
export const OUTLOOK_FREEBUSY_FLAG_KEY = 'outlook_calendar_freebusy';

const GET_SCHEDULE_URL = 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface OutlookFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
}
export interface OutlookFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}
export type OutlookFetch = (url: string, init: OutlookFetchInit) => Promise<OutlookFetchResponse>;

export interface OutlookFreeBusyProviderOptions {
  readonly enabled?: boolean;
  readonly getAccessToken: () => Promise<string | null>;
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly fetchFn?: OutlookFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface BusyBlock {
  readonly startMs: number;
  readonly endMs: number;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function toMs(iso: string): number | null {
  // Graph returns `dateTime` without an offset (e.g. ...T12:00:00.0000000);
  // the request pins timeZone=UTC, so treat an offset-less value as UTC.
  const withZ = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const t = Date.parse(withZ);
  return Number.isFinite(t) ? t : null;
}

function makeSlot(
  startMs: number,
  endMs: number,
  timeZone: string,
  calendarId: string,
  provider: string,
): AvailabilitySlot {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    timeZone,
    provenance: SlotProvenance.AUTHORITATIVE,
    confirmation: SlotConfirmation.SUGGESTED,
    source: { provider, calendarId },
  };
}

/** Merge overlapping busy blocks, then pack duration-sized free slots. */
function computeFreeSlots(
  windowStart: number,
  windowEnd: number,
  busy: readonly BusyBlock[],
  durationMinutes: number,
  timeZone: string,
  calendarId: string,
  provider: string,
  limit: number,
): AvailabilitySlot[] {
  const durationMs = durationMinutes * 60_000;
  const sorted = [...busy].sort((a, b) => a.startMs - b.startMs);
  const merged: BusyBlock[] = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (last && b.startMs <= last.endMs) {
      if (b.endMs > last.endMs) merged[merged.length - 1] = { startMs: last.startMs, endMs: b.endMs };
    } else {
      merged.push(b);
    }
  }

  const slots: AvailabilitySlot[] = [];
  let cursor = windowStart;
  for (const b of merged) {
    while (cursor + durationMs <= b.startMs && slots.length < limit) {
      slots.push(makeSlot(cursor, cursor + durationMs, timeZone, calendarId, provider));
      cursor += durationMs;
    }
    if (b.endMs > cursor) cursor = b.endMs;
    if (slots.length >= limit) break;
  }
  while (cursor + durationMs <= windowEnd && slots.length < limit) {
    slots.push(makeSlot(cursor, cursor + durationMs, timeZone, calendarId, provider));
    cursor += durationMs;
  }
  return slots;
}

export class OutlookFreeBusyProvider implements CalendarAvailabilityProvider {
  readonly key = OUTLOOK_FREEBUSY_PROVIDER_KEY;

  private readonly enabled: boolean;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly refreshAccessToken: (() => Promise<string | null>) | undefined;
  private readonly fetchFn: OutlookFetch;
  private readonly timeoutMs: number;

  constructor(options: OutlookFreeBusyProviderOptions) {
    this.enabled = options.enabled === true;
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
    this.fetchFn =
      options.fetchFn ??
      ((url, init) => globalThis.fetch(url, init) as Promise<OutlookFetchResponse>);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private failure(reason: AvailabilityFailureReason, detail: string): AvailabilityResult {
    return { ok: false, reason, detail, slots: [] };
  }

  async findAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    if (!this.enabled) {
      return this.failure(AvailabilityFailureReason.NOT_CONFIGURED, 'microsoft calendar free/busy is disabled by feature flag');
    }
    const validation = validateQuery(query);
    if (!validation.ok) {
      return this.failure(AvailabilityFailureReason.INVALID_REQUEST, validation.detail);
    }
    const n = validation.normalized;

    let token: string | null = null;
    try {
      token = await this.getAccessToken();
    } catch (error) {
      return this.failure(AvailabilityFailureReason.UNAVAILABLE, `credential provider threw: ${safeMessage(error)}`);
    }
    if (token === null || token.trim() === '') {
      return this.failure(AvailabilityFailureReason.NOT_CONFIGURED, 'no microsoft calendar credentials configured for this organization');
    }

    try {
      let response = await this.postGetSchedule(n, token);
      if (response.status === 401 && this.refreshAccessToken !== undefined) {
        const refreshed = await this.tryRefresh();
        if (refreshed !== null) response = await this.postGetSchedule(n, refreshed);
      }
      return await this.interpret(response, n);
    } catch (error) {
      return this.failure(AvailabilityFailureReason.UNAVAILABLE, `microsoft calendar provider failed: ${safeMessage(error)}`);
    }
  }

  private async tryRefresh(): Promise<string | null> {
    try {
      const token = await this.refreshAccessToken?.();
      return token === null || token === undefined || token.trim() === '' ? null : token;
    } catch {
      return null;
    }
  }

  private async postGetSchedule(
    n: { startUtc: string; endUtc: string; timeZone: string; calendarId: string },
    token: string,
  ): Promise<OutlookFetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(GET_SCHEDULE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedules: [n.calendarId],
          startTime: { dateTime: n.startUtc, timeZone: 'UTC' },
          endTime: { dateTime: n.endUtc, timeZone: 'UTC' },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new Error(timedOut ? `microsoft calendar request timed out after ${this.timeoutMs}ms` : `network error: ${safeMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async interpret(
    response: OutlookFetchResponse,
    n: { startUtc: string; endUtc: string; durationMinutes: number; timeZone: string; calendarId: string; limit: number },
  ): Promise<AvailabilityResult> {
    if (response.status === 401 || response.status === 403) {
      return this.failure(AvailabilityFailureReason.NOT_AUTHORIZED, `microsoft rejected the credentials (HTTP ${response.status})`);
    }
    if (response.status >= 500) {
      return this.failure(AvailabilityFailureReason.UNAVAILABLE, `microsoft calendar is unavailable (HTTP ${response.status})`);
    }
    if (response.status !== 200) {
      return this.failure(AvailabilityFailureReason.UNAVAILABLE, `microsoft calendar returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return this.failure(AvailabilityFailureReason.MALFORMED_RESPONSE, 'microsoft returned a non-JSON body');
    }

    const scheduleItems = this.parseScheduleItems(body);
    if (scheduleItems === null) {
      return this.failure(AvailabilityFailureReason.MALFORMED_RESPONSE, 'microsoft returned an unexpected schedule shape');
    }

    const busy: BusyBlock[] = [];
    for (const item of scheduleItems) {
      if (item.status !== 'busy' && item.status !== 'tentative' && item.status !== 'oof') continue;
      const startMs = toMs(item.start);
      const endMs = toMs(item.end);
      if (startMs === null || endMs === null || endMs <= startMs) continue;
      busy.push({ startMs, endMs });
    }

    const windowStart = Date.parse(n.startUtc);
    const windowEnd = Date.parse(n.endUtc);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
      return this.failure(AvailabilityFailureReason.INVALID_REQUEST, 'invalid window');
    }

    const slots = computeFreeSlots(windowStart, windowEnd, busy, n.durationMinutes, n.timeZone, n.calendarId, this.key, n.limit);
    return { ok: true, slots, fetchedAt: new Date().toISOString() };
  }

  private parseScheduleItems(body: unknown): Array<{ start: string; end: string; status: string }> | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const value = (body as Record<string, unknown>).value;
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0] as Record<string, unknown> | null;
    if (first === null || typeof first !== 'object') return null;
    const items = first.scheduleItems;
    if (!Array.isArray(items)) return null;
    const out: Array<{ start: string; end: string; status: string }> = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const start = (item.start as Record<string, unknown> | undefined)?.dateTime;
      const end = (item.end as Record<string, unknown> | undefined)?.dateTime;
      const status = item.status;
      if (typeof start !== 'string' || typeof end !== 'string' || typeof status !== 'string') return null;
      out.push({ start, end, status });
    }
    return out;
  }
}
