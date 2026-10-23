/**
 * Trusted configuration: which time zone a business operates in.
 *
 * ============================================================================
 * THE PROBLEM THIS SOLVES
 * ============================================================================
 *
 * Slice 1 takes `timeZone` from the caller, and records it in the header that
 * the customer's zone is a presentation concern. That was not enforced
 * anywhere — any caller could pass any zone, and availability would be computed
 * against it. A customer who says "I'm in Tokyo" would move the business's
 * opening hours.
 *
 * The fix is to make the business's zone a TRUSTED value that a caller cannot
 * set, and to treat any customer-supplied zone as presentation-only:
 *
 *     trusted  = organization's stored time zone   (this file)
 *     untrusted = what the customer said           (never used for arithmetic)
 *
 * A booking made at 10:00 in the business's zone is 10:00 regardless of the
 * zone the customer was reading it in. If the customer in Tokyo sees "18:00",
 * that is a rendering of the same instant, and rendering is not scheduling.
 *
 * ============================================================================
 * WHY `organizations.locale` IS NOT THE SOURCE
 * ============================================================================
 *
 * The schema already has `organizations.locale` (migration 20260830000001),
 * added for prompt language. Locale and time zone are different facts that
 * happen to correlate: a business in Mexico City may run its dashboard in
 * English and still open at 09:00 America/Mexico_City. Deriving one from the
 * other gives the right answer often enough to be trusted, and wrong at a
 * daylight-saving boundary where the consequence is a missed appointment.
 *
 * So the zone is a separate, explicit setting. Until a column exists for it,
 * the resolver below requires an explicit value and refuses to guess.
 */

/** Where a resolved time zone came from. Recorded so the answer is auditable. */
export enum TimeZoneSource {
  /** An explicit per-organization setting. The only trusted source. */
  ORGANIZATION_SETTING = 'ORGANIZATION_SETTING',
  /**
   * A fallback used because no setting exists. Still operator-controlled
   * configuration, never customer input.
   */
  PLATFORM_DEFAULT = 'PLATFORM_DEFAULT',
}

/** A trusted zone and the reason it was chosen. */
export interface ResolvedTimeZone {
  readonly timeZone: string;
  readonly source: TimeZoneSource;
  /**
   * True when the zone came from an explicit setting. False means a fallback
   * was used, and a caller that cares about precision (booking, reminders)
   * should surface that rather than proceed silently.
   */
  readonly isExplicit: boolean;
}

/** Raised when no trusted zone can be determined. */
export class TimeZoneResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeZoneResolutionError';
  }
}

/** Is this a zone this runtime knows about? */
function isValidZone(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

export interface OrganizationTimeZoneConfig {
  /** The organization's explicit setting, if one exists. */
  readonly organizationTimeZone?: string | null;
  /**
   * Platform-level fallback from environment configuration. Must itself be a
   * valid IANA zone; if it is not, resolution fails loudly rather than
   * silently treating UTC as "close enough".
   */
  readonly platformDefaultTimeZone?: string | null;
}

/**
 * Resolve the trusted time zone for an organization.
 *
 * Precedence: explicit organization setting, then platform default. Never the
 * customer's stated zone.
 *
 * An invalid organization setting is an error rather than a silent fallback: a
 * typo'd zone ("Europe/Madrid " with a space, "EST5EDT" mistyped) would
 * otherwise degrade to the platform default and produce plausible-looking
 * availability in the wrong zone, which is exactly the class of bug that
 * reaches a customer.
 */
export function resolveBusinessTimeZone(
  config: OrganizationTimeZoneConfig
): ResolvedTimeZone {
  const configured = config.organizationTimeZone;

  if (configured !== undefined && configured !== null) {
    if (!isValidZone(configured)) {
      throw new TimeZoneResolutionError(
        `organization time zone '${String(configured)}' is not a recognised IANA ` +
          'time zone; refusing to fall back, because the fallback would produce ' +
          'availability in a zone the business does not operate in'
      );
    }
    return {
      timeZone: configured,
      source: TimeZoneSource.ORGANIZATION_SETTING,
      isExplicit: true,
    };
  }

  const fallback = config.platformDefaultTimeZone;
  if (isValidZone(fallback)) {
    return {
      timeZone: fallback,
      source: TimeZoneSource.PLATFORM_DEFAULT,
      isExplicit: false,
    };
  }

  throw new TimeZoneResolutionError(
    'no organization time zone is configured and no valid platform default is ' +
      'set; refusing to guess, because a guessed zone silently shifts every ' +
      'slot the business offers'
  );
}

/**
 * Validate a customer-supplied zone without adopting it.
 *
 * Returns the zone if it parses, so a caller can render slots in the customer's
 * local time — and `null` otherwise, which a caller must treat as "render in
 * the business's zone" rather than as an error. A customer typing a nonsense
 * zone should not fail the request; it should simply not change the answer.
 */
export function normalizePresentationTimeZone(
  customerSupplied: unknown
): string | null {
  return isValidZone(customerSupplied) ? customerSupplied : null;
}
