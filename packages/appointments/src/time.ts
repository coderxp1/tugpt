/**
 * Input validation and time-zone arithmetic.
 *
 * Everything here is pure and dependency-free. `Intl` is the only clock
 * authority used; there is no home-grown offset table, because a home-grown
 * offset table is wrong twice a year and the twice it is wrong is exactly when
 * bookings get missed.
 */

import {
  AvailabilityFailureReason,
  type AvailabilityQuery,
  type InstantRange,
} from './provider.js';

/** Outcome of validating a query. */
export type ValidationResult =
  | { readonly ok: true; readonly normalized: NormalizedQuery }
  | {
      readonly ok: false;
      readonly reason: AvailabilityFailureReason.INVALID_REQUEST;
      readonly detail: string;
    };

/**
 * A query whose fields have been checked and canonicalized.
 *
 * `startUtc`/`endUtc` are the authoritative instants; `timeZone` is retained
 * because "09:00" means different instants in Madrid and in Mexico City, and
 * the difference must stay recoverable.
 */
export interface NormalizedQuery {
  readonly startUtc: string;
  readonly endUtc: string;
  readonly timeZone: string;
  readonly durationMinutes: number;
  readonly calendarId: string;
  readonly limit: number;
}

/** Maximum slots returned when the caller does not specify a limit. */
export const DEFAULT_SLOT_LIMIT = 20;

/** Hard ceiling, so a wide window cannot return an unbounded list. */
export const MAX_SLOT_LIMIT = 100;

/**
 * Longest window we will ask a provider about: 31 days.
 *
 * Not a performance guess. A booking request spanning months is almost always
 * a misparsed date rather than an intent, and answering it would bury the
 * genuinely available times under a wall of empty slots.
 */
export const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

/** Is `tz` a zone this runtime actually knows about? */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    // Throws RangeError for an unknown zone. This is the only reliable check:
    // the set of valid zones depends on the ICU data in the running runtime.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse an ISO-8601 instant, returning a `Date` or `null`. */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Reject date-only strings: `new Date('2026-10-19')` is midnight UTC, which
  // is a different day for most of the world and a silent off-by-one.
  if (!/T/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function invalid(detail: string): ValidationResult {
  return { ok: false, reason: AvailabilityFailureReason.INVALID_REQUEST, detail };
}

/**
 * Validate a caller's query, or explain in one sentence why it is unusable.
 *
 * Every rejection carries a reason suitable for an operator log. None of them
 * are suitable for a customer, and none of them ever result in an invented
 * slot.
 */
export function validateQuery(query: AvailabilityQuery): ValidationResult {
  if (query === null || typeof query !== 'object') {
    return invalid('query must be an object');
  }

  const { window, durationMinutes, timeZone, calendarId } = query;

  if (window === null || typeof window !== 'object') {
    return invalid('window is required');
  }

  if (typeof calendarId !== 'string' || calendarId.trim().length === 0) {
    return invalid('calendarId is required and must be a non-empty string');
  }

  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) {
    return invalid(`timeZone '${String(timeZone)}' is not a recognised IANA time zone`);
  }

  if (
    typeof durationMinutes !== 'number' ||
    !Number.isFinite(durationMinutes) ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return invalid('durationMinutes must be a positive whole number of minutes');
  }

  const start = parseInstant((window as InstantRange).start);
  const end = parseInstant((window as InstantRange).end);
  if (start === null) {
    return invalid('window.start must be an ISO-8601 instant (with time and offset)');
  }
  if (end === null) {
    return invalid('window.end must be an ISO-8601 instant (with time and offset)');
  }

  const spanMs = end.getTime() - start.getTime();
  if (spanMs <= 0) {
    return invalid('window.end must be after window.start');
  }
  if (spanMs > MAX_WINDOW_MS) {
    return invalid('window must not exceed 31 days');
  }

  // A duration longer than the window cannot fit; treat it as a bug rather
  // than silently returning nothing, which the caller would misread as
  // "fully booked".
  if (durationMinutes * 60_000 > spanMs) {
    return invalid('durationMinutes is longer than the requested window');
  }

  const rawLimit = (query as { limit?: unknown }).limit;
  let limit = DEFAULT_SLOT_LIMIT;
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit <= 0
    ) {
      return invalid('limit must be a positive whole number when provided');
    }
    limit = Math.min(rawLimit, MAX_SLOT_LIMIT);
  }

  return {
    ok: true,
    normalized: {
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      timeZone,
      durationMinutes,
      calendarId,
      limit,
    },
  };
}

/**
 * The UTC offset of `timeZone` at `instant`, in milliseconds.
 *
 * Computed by formatting the instant as wall-clock time in the target zone and
 * comparing against the same wall-clock time read as UTC. Doing it this way
 * means DST transitions come from the runtime's own zone data, so a
 * spring-forward gap or autumn overlap is handled by the same table the rest
 * of the platform uses.
 */
export function offsetMsAt(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  // `hour` can come back as 24 under hour12:false in some ICU versions; normalise.
  const hour = get('hour') % 24;

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second')
  );

  return asUtc - instant.getTime();
}

/** True when the two instants fall on the same local calendar date in `timeZone`. */
export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(a) === fmt.format(b);
}

/**
 * Does a `[start, end)` range fit entirely inside `window`?
 *
 * Provider answers are clipped to the requested window before being returned.
 * A provider that ignores the window — some booking APIs pad to whole days —
 * would otherwise let TuGPT offer a 07:00 slot to a business that opens at
 * 09:00.
 */
export function isWithinWindow(
  start: Date,
  end: Date,
  windowStart: Date,
  windowEnd: Date
): boolean {
  return (
    start.getTime() >= windowStart.getTime() &&
    end.getTime() <= windowEnd.getTime() &&
    end.getTime() > start.getTime()
  );
}

/** Render an instant in a zone, for operator logs and provider payloads. */
export function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}
