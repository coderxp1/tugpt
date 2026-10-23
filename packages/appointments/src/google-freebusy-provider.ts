/**
 * A read-only Google Calendar availability provider, backed by the
 * `freeBusy.query` endpoint.
 *
 * ============================================================================
 * WHY THIS PROVIDER ONLY READS, AND SAYS SO IN ITS SIGNATURE
 * ============================================================================
 *
 * The contract (`CalendarAvailabilityProvider`) exposes exactly one method and
 * it reads. This implementation honors that by calling a single HTTP
 * endpoint whose vocabulary has no write verb: `freeBusy.query` answers
 * "when is this calendar occupied?" and can neither create, update nor delete
 * anything. There is no code path here that POSTs to `events.insert`,
 * `events.patch` or any other mutating route — the URLs and bodies are string
 * literals in this file, and `freeBusy` is the only one.
 *
 * The other load-bearing decision is the token. The `calendar.freebusy`
 * scope is the least-privilege scope Google offers for this question: it
 * grants exactly "read free/busy" and nothing else — no event titles, no
 * attendee names, no locations, which the schema (migration 20261019000001)
 * has nowhere to store anyway. The adapter cannot verify at runtime which
 * scopes a token carries; the composition root that mints the token MUST
 * request exactly `GOOGLE_FREEBUSY_SCOPE` (exported below) and nothing wider.
 * Stating that requirement in prose rather than enforcing it is a deliberate,
 * documented gap: token introspection would be a second network call on the
 * hot path, and silently accepting a wider token would be worse than saying
 * so. The failure mode "token has wider scopes than needed" degrades to the
 * caller holding a stronger credential — it does not let the provider write,
 * because no write call exists here.
 *
 * ============================================================================
 * FEATURE FLAG: OFF UNTIL A HUMAN SAYS OTHERWISE
 * ============================================================================
 *
 * `enabled` defaults to `false`. A disabled provider answers every query with
 * `NOT_CONFIGURED` without touching the network, without asking for a token,
 * and without leaving the process. This package has no database access
 * (`index.ts` says so), so the flag cannot be read from `feature_flags` here;
 * the composition root wires it (env var, remote config) into the
 * constructor, per organization, when it has credentials to offer. The
 * constant `GOOGLE_FREEBUSY_FLAG_KEY` names the key to use if that root is
 * the database's `feature_flags` table.
 *
 * ============================================================================
 * WHAT "AVAILABLE" MEANS HERE, AND WHAT IT DOES NOT MEAN
 * ============================================================================
 *
 * A returned slot is `SUGGESTED` and `AUTHORITATIVE`: Google said the
 * calendar was not occupied there. It is NOT a hold, a reservation, or a
 * booking — anyone can book into it between this answer and any later
 * attempt, which is why slice 2 refuses to persist `CONFIRMED`. The provider
 * computes free intervals by subtracting Google's busy blocks from the
 * requested window and packing duration-sized slots from each interval's
 * start; every emitted slot lies entirely inside the window and is exactly
 * `durationMinutes` long, so the service's normalisation keeps rather than
 * drops them.
 *
 * Failure mapping (the five `AvailabilityFailureReason` values are the whole
 * vocabulary — a Google error that does not fit is UNAVAILABLE, never a
 * guess):
 *
 *   disabled flag / no token        -> NOT_CONFIGURED
 *   401 (and a refresh did not fix it) -> NOT_AUTHORIZED
 *   403 for any reason other than quota -> NOT_AUTHORIZED
 *   403 with rateLimitExceeded/userRateLimitExceeded, 429, 5xx, timeout,
 *     network throw                   -> UNAVAILABLE (retryable)
 *   per-calendar `notFound` error    -> NOT_CONFIGURED
 *   other per-calendar error        -> UNAVAILABLE
 *   non-JSON body, missing calendars, unparseable busy instants,
 *     inverted busy interval         -> MALFORMED_RESPONSE (the answer cannot
 *                                        be trusted, so there is no answer)
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

/** Provider key, matched against `AvailabilitySource.provider`. */
export const GOOGLE_FREEBUSY_PROVIDER_KEY = 'google-calendar';

/**
 * The only OAuth scope a token given to this provider may carry.
 *
 * Read-only free/busy. It answers "is this time occupied?" — the single
 * question this provider asks — and grants no event content, no attendee
 * data, and no write of any kind. The composition root MUST request exactly
 * this scope; see the header for why the adapter cannot verify it.
 */
export const GOOGLE_FREEBUSY_SCOPE =
  'https://www.googleapis.com/auth/calendar.freebusy';

/**
 * Suggested `feature_flags.key` for the composition root, if it reads flags
 * from the database. The adapter itself takes `enabled` in its constructor
 * and stays off by default.
 */
export const GOOGLE_FREEBUSY_FLAG_KEY = 'google_calendar_freebusy';

/** Endpoint. The only URL this provider ever calls. */
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

/** Default HTTP timeout: a hung calendar must not hang a conversation. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimal surface of `fetch` this provider needs. `Response` satisfies it. */
export interface FreeBusyFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface FreeBusyFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type FreeBusyFetch = (
  url: string,
  init: FreeBusyFetchInit
) => Promise<FreeBusyFetchResponse>;

export interface GoogleFreeBusyProviderOptions {
  /**
   * Feature flag. Defaults to `false`: the provider is OFF until enabled.
   * When off, every query resolves NOT_CONFIGURED with no network traffic.
   */
  readonly enabled?: boolean;
  /**
   * Bound to this instance per organization, so the token never travels
   * through request data, logs or queues. Return `null` when the org has no
   * Google credentials yet — that becomes NOT_CONFIGURED, not an exception.
   */
  readonly getAccessToken: () => Promise<string | null>;
  /**
   * Optional single retry for expired tokens: called once after a 401, and
   * the original request is repeated once with the new token. Absent or
   * returning `null` means a 401 is terminal (NOT_AUTHORIZED).
   */
  readonly refreshAccessToken?: () => Promise<string | null>;
  /** Injectable HTTP. Defaults to the global fetch. */
  readonly fetchFn?: FreeBusyFetch;
  /** HTTP timeout in milliseconds. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** Fixed clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface BusyBlock {
  readonly startMs: number;
  readonly endMs: number;
}

export class GoogleFreeBusyProvider implements CalendarAvailabilityProvider {
  readonly key = GOOGLE_FREEBUSY_PROVIDER_KEY;

  private readonly enabled: boolean;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly refreshAccessToken:
    | (() => Promise<string | null>)
    | undefined;
  private readonly fetchFn: FreeBusyFetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: GoogleFreeBusyProviderOptions) {
    this.enabled = options.enabled === true;
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
    this.fetchFn =
      options.fetchFn ??
      ((url, init) => globalThis.fetch(url, init) as Promise<FreeBusyFetchResponse>);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async findAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    // A disabled provider never touches the network and never asks for a
    // token. The detail names the flag mechanism so an operator knows where
    // the switch lives.
    if (!this.enabled) {
      return this.failure(
        AvailabilityFailureReason.NOT_CONFIGURED,
        'google calendar free/busy is disabled by feature flag'
      );
    }

    const validation = validateQuery(query);
    if (!validation.ok) {
      return this.failure(
        AvailabilityFailureReason.INVALID_REQUEST,
        validation.detail
      );
    }
    const normalized = validation.normalized;

    let token: string | null = null;
    try {
      token = await this.getAccessToken();
    } catch (error) {
      return this.failure(
        AvailabilityFailureReason.UNAVAILABLE,
        `credential provider threw: ${this.safeMessage(error)}`
      );
    }
    if (token === null || token.trim() === '') {
      return this.failure(
        AvailabilityFailureReason.NOT_CONFIGURED,
        'no google calendar credentials configured for this organization'
      );
    }

    try {
      let response = await this.postFreeBusy(
        normalized,
        token,
        normalized.calendarId
      );

      // One refresh attempt on 401: the token may simply have expired.
      if (response.status === 401 && this.refreshAccessToken !== undefined) {
        const refreshed = await this.tryRefresh();
        if (refreshed !== null) {
          response = await this.postFreeBusy(
            normalized,
            refreshed,
            normalized.calendarId
          );
        }
      }

      return await this.interpret(response, normalized);
    } catch (error) {
      // The provider contract is "resolve, never reject": every transport or
      // per-calendar fault becomes a typed failure, so a conversation loop
      // cannot lose a turn to this provider.
      if (error instanceof FreeBusyTransportError) {
        return this.failure(
          AvailabilityFailureReason.UNAVAILABLE,
          error.timedOut
            ? `google calendar request timed out after ${this.timeoutMs}ms`
            : `google calendar transport error: ${error.message}`
        );
      }
      if (error instanceof FreeBusyCalendarError) {
        return this.failure(error.reason, error.message);
      }
      return this.failure(
        AvailabilityFailureReason.UNAVAILABLE,
        `google calendar provider failed: ${this.safeMessage(error)}`
      );
    }
  }

  private async tryRefresh(): Promise<string | null> {
    try {
      const token = await this.refreshAccessToken?.();
      return token === null || token === undefined || token.trim() === ''
        ? null
        : token;
    } catch {
      return null;
    }
  }

  private async postFreeBusy(
    normalized: {
      startUtc: string;
      endUtc: string;
      timeZone: string;
      calendarId: string;
    },
    token: string,
    calendarId: string
  ): Promise<FreeBusyFetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(FREEBUSY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          timeMin: normalized.startUtc,
          timeMax: normalized.endUtc,
          timeZone: normalized.timeZone,
          items: [{ id: calendarId }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Re-throw as a tagged error the interpreter can classify without
      // depending on the concrete fetch implementation.
      const timedOut =
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new FreeBusyTransportError(
        timedOut ? 'request timed out' : `network error: ${this.safeMessage(error)}`,
        timedOut
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async interpret(
    response: FreeBusyFetchResponse,
    normalized: {
      startUtc: string;
      endUtc: string;
      durationMinutes: number;
      timeZone: string;
      calendarId: string;
      limit: number;
    }
  ): Promise<AvailabilityResult> {
    const { status } = response;

    if (status === 401 || status === 403) {
      const reason = await this.googleErrorReason(response);
      if (reason !== null && /ratelimitexceeded/i.test(reason)) {
        return this.failure(
          AvailabilityFailureReason.UNAVAILABLE,
          `google calendar quota exceeded (HTTP ${status})`
        );
      }
      return this.failure(
        AvailabilityFailureReason.NOT_AUTHORIZED,
        `google rejected the credentials (HTTP ${status})`
      );
    }

    if (status === 429) {
      return this.failure(
        AvailabilityFailureReason.UNAVAILABLE,
        'google calendar rate limit exceeded (HTTP 429)'
      );
    }

    if (status >= 500) {
      return this.failure(
        AvailabilityFailureReason.UNAVAILABLE,
        `google calendar returned HTTP ${status}`
      );
    }

    if (status === 404) {
      return this.failure(
        AvailabilityFailureReason.NOT_CONFIGURED,
        'google calendar not found for this organization (HTTP 404)'
      );
    }

    if (status < 200 || status >= 300) {
      return this.failure(
        AvailabilityFailureReason.MALFORMED_RESPONSE,
        `google calendar returned an unexpected HTTP ${status}`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failure(
        AvailabilityFailureReason.MALFORMED_RESPONSE,
        'google calendar returned a non-JSON free/busy response'
      );
    }

    const busy = this.extractBusy(payload, normalized.calendarId);
    if (busy === null) {
      return this.failure(
        AvailabilityFailureReason.MALFORMED_RESPONSE,
        'google calendar free/busy response was not in the expected shape'
      );
    }

    const slots = this.packSlots(
      normalized.startUtc,
      normalized.endUtc,
      busy,
      normalized.durationMinutes,
      normalized.limit,
      normalized.timeZone,
      normalized.calendarId
    );

    return {
      ok: true,
      slots,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * The busy blocks for our calendar, or `null` when the payload cannot be
   * trusted. A payload that mentions the wrong calendar is treated the same
   * as a malformed one: answering from another calendar's busy blocks would
   * be inventing availability.
   */
  private extractBusy(
    payload: unknown,
    calendarId: string
  ): BusyBlock[] | null {
    if (payload === null || typeof payload !== 'object') return null;
    const calendars = (payload as { calendars?: unknown }).calendars;
    if (calendars === null || typeof calendars !== 'object') return null;
    const entry = (calendars as Record<string, unknown>)[calendarId];
    if (entry === null || typeof entry !== 'object') return null;

    const errors = (entry as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const reasons = errors
        .map((e) =>
          e !== null && typeof e === 'object'
            ? String((e as { reason?: unknown }).reason ?? '')
            : ''
        )
        .join(',');
      // A per-calendar error is not data; it is a failure with a name.
      throw new FreeBusyCalendarError(
        /notfound/i.test(reasons)
          ? AvailabilityFailureReason.NOT_CONFIGURED
          : AvailabilityFailureReason.UNAVAILABLE,
        `google calendar '${calendarId}' reported an error`
      );
    }

    const rawBusy = (entry as { busy?: unknown }).busy;
    if (!Array.isArray(rawBusy)) return null;

    const busy: BusyBlock[] = [];
    for (const block of rawBusy) {
      if (block === null || typeof block !== 'object') return null;
      const startMs = Date.parse(
        String((block as { start?: unknown }).start ?? '')
      );
      const endMs = Date.parse(
        String((block as { end?: unknown }).end ?? '')
      );
      // An unparseable or inverted busy block poisons the answer: without
      // it we cannot know the window is truly free, so there is no answer
      // rather than a partial one.
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null;
      }
      busy.push({ startMs, endMs });
    }
    return busy;
  }

  /**
   * Free intervals = window minus merged busy blocks; slots packed from the
   * start of each free interval in whole-duration steps. Deterministic, and
   * every emitted slot is exactly `durationMinutes` long and inside the
   * window, so the service keeps rather than drops them.
   */
  private packSlots(
    startUtc: string,
    endUtc: string,
    busy: BusyBlock[],
    durationMinutes: number,
    limit: number,
    timeZone: string,
    calendarId: string
  ): AvailabilitySlot[] {
    const windowStart = Date.parse(startUtc);
    const windowEnd = Date.parse(endUtc);
    const durationMs = durationMinutes * 60_000;

    const merged: Array<{ startMs: number; endMs: number }> = [...busy]
      .map((b) => ({
        startMs: Math.max(b.startMs, windowStart),
        endMs: Math.min(b.endMs, windowEnd),
      }))
      .filter((b) => b.endMs > b.startMs)
      .sort((a, b) => a.startMs - b.startMs);

    const consolidated: Array<{ startMs: number; endMs: number }> = [];
    for (const block of merged) {
      const last = consolidated[consolidated.length - 1];
      if (last !== undefined && block.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, block.endMs);
      } else {
        consolidated.push({ ...block });
      }
    }

    const slots: AvailabilitySlot[] = [];
    let cursor = windowStart;
    const pushFree = (freeStart: number, freeEnd: number): void => {
      let start = freeStart;
      while (
        start + durationMs <= freeEnd &&
        slots.length < limit
      ) {
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(start + durationMs).toISOString(),
          timeZone,
          provenance: SlotProvenance.AUTHORITATIVE,
          confirmation: SlotConfirmation.SUGGESTED,
          source: { provider: this.key, calendarId },
        });
        start += durationMs;
      }
    };

    for (const block of consolidated) {
      if (block.startMs > cursor) pushFree(cursor, block.startMs);
      cursor = Math.max(cursor, block.endMs);
    }
    if (cursor < windowEnd) pushFree(cursor, windowEnd);

    return slots;
  }

  /**
   * The provider-level error reason, if Google gave one in the documented
   * `{error: {errors: [{reason}]}}` shape. Never throws: classification
   * falling back to "no reason" still produces a correct outcome.
   */
  private async googleErrorReason(
    response: FreeBusyFetchResponse
  ): Promise<string | null> {
    try {
      const body = (await response.json()) as {
        error?: { errors?: Array<{ reason?: string }> };
      };
      const reasons = body?.error?.errors ?? [];
      return reasons
        .map((e) => e?.reason ?? '')
        .filter((r) => r.length > 0)
        .join(',');
    } catch {
      return null;
    }
  }

  private failure(
    reason: AvailabilityFailureReason,
    detail: string
  ): AvailabilityResult {
    return { ok: false, reason, detail, slots: [] };
  }

  /** Error text with no secrets: nothing here ever interpolates a token. */
  private safeMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}

/**
 * Transport-level failure (network throw, timeout) raised by `postFreeBusy`
 * and mapped to UNAVAILABLE by the catch in `findAvailability`, so the
 * provider's promise always resolves.
 */
class FreeBusyTransportError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(message);
    this.name = 'FreeBusyTransportError';
    this.timedOut = timedOut;
  }
}

/** A per-calendar error in an otherwise-200 response. */
class FreeBusyCalendarError extends Error {
  readonly reason: AvailabilityFailureReason;
  constructor(reason: AvailabilityFailureReason, detail: string) {
    super(detail);
    this.name = 'FreeBusyCalendarError';
    this.reason = reason;
  }
}
