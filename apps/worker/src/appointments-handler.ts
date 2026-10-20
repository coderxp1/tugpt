import type {
  AppointmentRequestRecord,
  AppointmentSuggestionRecord,
  AvailabilityFailureReason,
} from '@tugpt/appointments';
import type { AppointmentsDeps } from './appointments-deps-factory.js';

/**
 * @file appointments-handler.ts
 * @description The application entry point for appointment availability:
 * validates an untrusted request payload, resolves the per-organization
 * runtime through the composition factory, and returns a stable result.
 *
 * This is the unit the transports call. `appointments-index.ts` feeds it
 * NDJSON lines today; a future HTTP route or queue consumer calls the same
 * function. Keeping validation and outcome mapping here means no transport
 * can bypass them.
 *
 * ===========================================================================
 * FAIL-CLOSED, AT THIS BOUNDARY FIRST
 * ===========================================================================
 *
 *   - A malformed payload is refused as INVALID_REQUEST before any I/O:
 *     no factory resolution, no database row, no provider call. A bad
 *     request must not be able to create state.
 *   - Semantic validation (window ordering, duration bounds against the
 *     trusted zone) stays with the service, which already answers those as
 *     typed outcomes rather than throwing.
 *   - Anything the factory or store throws (a database outage surfaces as
 *     a typed store error) is caught and mapped to UNAVAILABLE with a
 *     generic detail. Internal error text never crosses this boundary.
 *   - Provider failures are NOT exceptions here: the service resolves them
 *     as outcomes, and the provider's reason is passed through verbatim so
 *     a caller can distinguish NOT_CONFIGURED from UNAVAILABLE.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppointmentHandlerResult =
  | {
      readonly ok: true;
      readonly request: AppointmentRequestRecord;
      readonly suggestions: readonly AppointmentSuggestionRecord[];
    }
  | {
      readonly ok: false;
      /** An AvailabilityFailureReason for provider outcomes; a boundary code otherwise. */
      readonly code: AvailabilityFailureReason | 'INVALID_REQUEST' | 'UNAVAILABLE';
      readonly detail: string;
    };

export type AppointmentRequestHandler = (
  payload: unknown
) => Promise<AppointmentHandlerResult>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function invalid(detail: string): AppointmentHandlerResult {
  return { ok: false, code: 'INVALID_REQUEST', detail };
}

/**
 * Build the handler around a composition factory. The factory is resolved
 * per request (per organization), so flag flips, credential rotations and
 * time-zone changes apply to the next request — the same property the
 * transcription factory was built for.
 */
export function createAppointmentRequestHandler(
  deps: AppointmentsDeps
): AppointmentRequestHandler {
  return async (payload: unknown) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return invalid('payload must be a JSON object');
    }
    const p = payload as Record<string, unknown>;

    if (!isUuid(p['organizationId'])) {
      return invalid('organizationId must be a UUID');
    }
    if (!isBoundedString(p['idempotencyKey'], 512)) {
      return invalid('idempotencyKey must be a non-empty string of at most 512 characters');
    }
    if (!isInstant(p['windowStart']) || !isInstant(p['windowEnd'])) {
      return invalid('windowStart and windowEnd must be ISO 8601 instants');
    }
    if (
      typeof p['durationMinutes'] !== 'number' ||
      !Number.isInteger(p['durationMinutes']) ||
      p['durationMinutes'] <= 0 ||
      p['durationMinutes'] > 480
    ) {
      return invalid('durationMinutes must be an integer between 1 and 480');
    }
    if (!isBoundedString(p['calendarId'], 200)) {
      return invalid('calendarId must be a non-empty string of at most 200 characters');
    }
    const contactId = p['contactId'] ?? null;
    const conversationId = p['conversationId'] ?? null;
    if (contactId !== null && !isUuid(contactId)) {
      return invalid('contactId must be a UUID or null');
    }
    if (conversationId !== null && !isUuid(conversationId)) {
      return invalid('conversationId must be a UUID or null');
    }

    try {
      const org = await deps.forOrganization(p['organizationId']);
      const outcome = await org.service.requestAvailability({
        organizationId: p['organizationId'],
        idempotencyKey: p['idempotencyKey'],
        windowStart: p['windowStart'],
        windowEnd: p['windowEnd'],
        durationMinutes: p['durationMinutes'],
        calendarId: p['calendarId'],
        contactId,
        conversationId,
      });

      if (outcome.ok) {
        return {
          ok: true,
          request: outcome.request,
          suggestions: outcome.suggestions,
        };
      }
      return { ok: false, code: outcome.reason, detail: outcome.detail };
    } catch {
      // The store throws typed errors for database failures; the factory can
      // throw resolving the trusted zone. Both are infrastructure faults from
      // the caller's side of this boundary, and neither's message is safe to
      // forward — it can carry driver text.
      return {
        ok: false,
        code: 'UNAVAILABLE',
        detail: 'the appointments service could not complete the request',
      };
    }
  };
}
