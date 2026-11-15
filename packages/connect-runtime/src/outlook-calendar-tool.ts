/**
 * calendar.find_availability â€” Microsoft 365 (Outlook), read-only.
 * The M365 counterpart of google-calendar-tool.ts. Reuses the same validation
 * and output shape; the only differences are the provider (microsoft) and the
 * Graph-backed OutlookFreeBusyProvider. Token comes from the runtime (broker).
 */

import {
  AvailabilityFailureReason,
  OUTLOOK_FREEBUSY_SCOPE,
  OutlookFreeBusyProvider,
  type OutlookFetch,
} from '@tugpt/appointments';
import {
  CALENDAR_FIND_AVAILABILITY,
  MAX_AVAILABILITY_WINDOW_DAYS,
  validateFindAvailability,
  type FindAvailabilityArgs,
} from './google-calendar-tool.js';
import type { ConnectTool, ToolErrorCode } from './types.js';

const MAX_LIMIT = 20;

const FAILURE_MAP: Readonly<Record<AvailabilityFailureReason, ToolErrorCode>> = {
  [AvailabilityFailureReason.NOT_AUTHORIZED]: 'REAUTHORIZATION_REQUIRED',
  [AvailabilityFailureReason.NOT_CONFIGURED]: 'CONNECTION_NOT_ACTIVE',
  [AvailabilityFailureReason.INVALID_REQUEST]: 'INVALID_ARGUMENTS',
  [AvailabilityFailureReason.UNAVAILABLE]: 'PROVIDER_UNAVAILABLE',
  [AvailabilityFailureReason.MALFORMED_RESPONSE]: 'PROVIDER_UNAVAILABLE',
};

export interface OutlookCalendarToolOptions {
  readonly fetchFn?: OutlookFetch;
  readonly timeoutMs?: number;
}

export function createOutlookFindAvailabilityTool(
  opts: OutlookCalendarToolOptions = {},
): ConnectTool<FindAvailabilityArgs> {
  return {
    capability: CALENDAR_FIND_AVAILABILITY,
    modelName: 'calendar_find_availability',
    provider: 'microsoft',
    risk: 'read',
    acceptedScopes: [OUTLOOK_FREEBUSY_SCOPE],
    description:
      "Find free time slots in the user's Microsoft 365 (Outlook) calendar between two ISO-8601 timestamps. Read-only; returns slot start/end times only.",
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
      const provider = new OutlookFreeBusyProvider({
        enabled: true,
        getAccessToken: async () => deps.accessToken,
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      const result = await provider.findAvailability({
        window: { start: args.start, end: args.end },
        durationMinutes: args.durationMinutes,
        timeZone: args.timeZone,
        // Graph `getSchedule` schedules[] is the owner's UPN/email; the
        // signed-in user's own schedule is resolved by `/me`. Populate from
        // the connection's external_account_id once that is wired through.
        calendarId: 'me',
        limit: args.limit,
      });
      if (!result.ok) {
        return { ok: false, code: FAILURE_MAP[result.reason] ?? 'PROVIDER_UNAVAILABLE' };
      }
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
