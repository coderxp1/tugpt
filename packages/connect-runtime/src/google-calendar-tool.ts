/**
 * calendar.find_availability — Google Calendar, read-only (ADR-021 first slice).
 *
 * Wraps the existing, already-reviewed `GoogleFreeBusyProvider` from
 * @tugpt/appointments instead of re-implementing the Google call. The token
 * comes from the credential broker via the runtime; this module never sees a
 * refresh token, the key ring, or another org's data.
 *
 * Output contains only computed free slots — no event titles, attendees or
 * descriptions (the freebusy scope cannot return them anyway).
 */
import {
  AvailabilityFailureReason,
  GOOGLE_FREEBUSY_SCOPE,
  GoogleFreeBusyProvider,
  isValidTimeZone,
  type FreeBusyFetch,
} from '@tugpt/appointments';
import type { ConnectTool, ToolErrorCode, ValidationOutcome } from './types.js';

export const CALENDAR_FIND_AVAILABILITY = 'calendar.find_availability';
export const MAX_AVAILABILITY_WINDOW_DAYS = 14;
const MAX_LIMIT = 20;

/**
 * Least privilege: freebusy is preferred. Broader read scopes held by
 * existing connections are accepted (they are a superset); write scopes alone
 * are not listed because accepting them would normalise over-broad grants.
 */
export const CALENDAR_ACCEPTED_SCOPES = [
  GOOGLE_FREEBUSY_SCOPE,
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

export interface FindAvailabilityArgs {
  readonly start: string;
  readonly end: string;
  readonly durationMinutes: number;
  readonly timeZone: string;
  readonly limit: number;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ALLOWED_KEYS = new Set(['start', 'end', 'durationMinutes', 'timeZone', 'limit']);

export function validateFindAvailability(raw: Readonly<Record<string, unknown>>, now: number): ValidationOutcome<FindAvailabilityArgs> {
  for (const k of Object.keys(raw)) if (!ALLOWED_KEYS.has(k)) return { ok: false, detail: `unexpected argument: ${k.slice(0, 32)}` };
  const { start, end, durationMinutes } = raw;
  const timeZone = raw.timeZone ?? 'UTC';
  const limit = raw.limit ?? 10;
  if (typeof start !== 'string' || !ISO_INSTANT.test(start)) return { ok: false, detail: 'start must be ISO-8601 with offset' };
  if (typeof end !== 'string' || !ISO_INSTANT.test(end)) return { ok: false, detail: 'end must be ISO-8601 with offset' };
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return { ok: false, detail: 'end must be after start' };
  if (e - s > MAX_AVAILABILITY_WINDOW_DAYS * 86_400_000) return { ok: false, detail: `window exceeds ${MAX_AVAILABILITY_WINDOW_DAYS} days` };
  if (e <= now) return { ok: false, detail: 'window is entirely in the past' };
  if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    return { ok: false, detail: 'durationMinutes must be an integer 5..480' };
  }
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) return { ok: false, detail: 'timeZone must be an IANA zone' };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, detail: `limit must be an integer 1..${MAX_LIMIT}` };
  }
  return {
    ok: true,
    value: { start: new Date(s).toISOString(), end: new Date(e).toISOString(), durationMinutes, timeZone, limit },
  };
}

const FAILURE_MAP: Readonly<Record<AvailabilityFailureReason, ToolErrorCode>> = {
  [AvailabilityFailureReason.NOT_AUTHORIZED]: 'REAUTHORIZATION_REQUIRED',
  [AvailabilityFailureReason.NOT_CONFIGURED]: 'CONNECTION_NOT_ACTIVE',
  [AvailabilityFailureReason.INVALID_REQUEST]: 'INVALID_ARGUMENTS',
  [AvailabilityFailureReason.UNAVAILABLE]: 'PROVIDER_UNAVAILABLE',
  [AvailabilityFailureReason.MALFORMED_RESPONSE]: 'PROVIDER_UNAVAILABLE',
};

export interface GoogleCalendarToolOptions {
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchFn?: FreeBusyFetch;
  readonly timeoutMs?: number;
}

export function createCalendarFindAvailabilityTool(opts: GoogleCalendarToolOptions = {}): ConnectTool<FindAvailabilityArgs> {
  return {
    capability: CALENDAR_FIND_AVAILABILITY,
    modelName: 'calendar_find_availability',
    provider: 'google',
    risk: 'read',
    acceptedScopes: CALENDAR_ACCEPTED_SCOPES,
    description:
      "Find free time slots in the user's primary Google Calendar between two ISO-8601 timestamps. Read-only; returns slot start/end times only.",
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Window start, ISO-8601 with offset, e.g. 2026-11-20T09:00:00Z' },
        end: { type: 'string', description: `Window end, ISO-8601 with offset; at most ${MAX_AVAILABILITY_WINDOW_DAYS} days after start` },
        durationMinutes: { type: 'integer', minimum: 5, maximum: 480 },
        timeZone: { type: 'string', description: 'IANA time zone, default UTC' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['start', 'end', 'durationMinutes'],
      additionalProperties: false,
    },
    validate: validateFindAvailability,
    async execute(args, deps) {
      const provider = new GoogleFreeBusyProvider({
        enabled: true, // the org policy gate already ran in the runtime
        getAccessToken: async () => deps.accessToken,
        now: deps.now,
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      const result = await provider.findAvailability({
        window: { start: args.start, end: args.end },
        durationMinutes: args.durationMinutes,
        timeZone: args.timeZone,
        calendarId: 'primary',
        limit: args.limit,
      });
      if (!result.ok) return { ok: false, code: FAILURE_MAP[result.reason] ?? 'PROVIDER_UNAVAILABLE' };
      return {
        ok: true,
        data: {
          timeZone: args.timeZone,
          fetchedAt: result.fetchedAt,
          slots: result.slots.map((s) => ({ start: s.start, end: s.end })),
        },
      };
    },
  };
}
