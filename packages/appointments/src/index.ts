/**
 * @tugpt/appointments — read-only, provider-backed appointment availability.
 *
 * This package answers one question — "what times is this business actually
 * free?" — and nothing else. It contains no booking creation, no calendar
 * writes, no WhatsApp wiring and no database access. Those are later slices
 * with their own idempotency and confirmation requirements.
 *
 * The rule it enforces, from Blueprint v1.4 §19.2/§21.2: never invent
 * availability. A provider failure yields an empty, typed result; a malformed
 * request never reaches a provider at all; and every returned slot is stamped
 * `AUTHORITATIVE` (the provider said so) and `SUGGESTED` (nobody holds it).
 */

export {
  AvailabilityFailureReason,
  SlotConfirmation,
  SlotProvenance,
  type AvailabilityQuery,
  type AvailabilityResult,
  type AvailabilitySlot,
  type AvailabilitySource,
  type CalendarAvailabilityProvider,
  type InstantRange,
  type TimeZoneId,
} from './provider.js';

export {
  AvailabilityService,
  type AvailabilityServiceOptions,
} from './availability-service.js';

export {
  DEFAULT_SLOT_LIMIT,
  MAX_SLOT_LIMIT,
  MAX_WINDOW_MS,
  formatInZone,
  isSameLocalDay,
  isValidTimeZone,
  isWithinWindow,
  offsetMsAt,
  parseInstant,
  validateQuery,
  type NormalizedQuery,
  type ValidationResult,
} from './time.js';

export {
  MockBehaviour,
  MockCalendarAvailabilityProvider,
  type MockProviderOptions,
} from './mock-provider.js';

export {
  recordAvailabilityRead,
  type AvailabilityObserver,
  type AvailabilityReadEvent,
} from './observability.js';

// --- Slice 2: persistence -------------------------------------------------

export {
  AppointmentRequestStatus,
  AppointmentSuggestionStatus,
  AppointmentStoreError,
  AppointmentStoreErrorCode,
  DEFAULT_SUGGESTION_TTL_MS,
  assertPersistableSlot,
  type AppointmentRequestRecord,
  type AppointmentStore,
  type AppointmentSuggestionRecord,
  type NewAppointmentRequest,
} from './persistence.js';

export {
  InMemoryAppointmentStore,
  type InMemoryAppointmentStoreOptions,
} from './in-memory-store.js';

export {
  TimeZoneResolutionError,
  TimeZoneSource,
  normalizePresentationTimeZone,
  resolveBusinessTimeZone,
  type OrganizationTimeZoneConfig,
  type ResolvedTimeZone,
} from './time-zone-config.js';

export {
  AppointmentsService,
  filterCurrentSuggestions,
  isSuggestionCurrent,
  type AppointmentsConfig,
  type RequestAvailabilityInput,
  type RequestAvailabilityOutcome,
} from './appointments-service.js';

// --- Slice 3: Google Calendar free/busy (read-only, flag-gated) -----------

export {
  GoogleFreeBusyProvider,
  GOOGLE_FREEBUSY_FLAG_KEY,
  GOOGLE_FREEBUSY_PROVIDER_KEY,
  GOOGLE_FREEBUSY_SCOPE,
  type FreeBusyFetch,
  type FreeBusyFetchInit,
  type FreeBusyFetchResponse,
  type GoogleFreeBusyProviderOptions,
} from './google-freebusy-provider.js';

// --- Slice 3 (cont.): per-organization feature gating ---------------------

export {
  createGoogleFreeBusyProvider,
  isGoogleFreeBusyEnabledForOrg,
  type FeatureFlagReader,
  type GoogleFreeBusyIntegrationOptions,
} from './feature-gates.js';

// --- Slice 3 (cont.): the production (Supabase-backed) store ---------------

export {
  SupabaseAppointmentStore,
  type SupabaseAppointmentStoreOptions,
  type SupabaseClientLike,
  type SupabaseErrorLike,
  type SupabaseQueryLike,
  type SupabaseResultLike,
} from './supabase-store.js';
export {
  GOOGLE_OAUTH_PROVIDER,
  GOOGLE_CALENDAR_SECRET_NAME,
  GOOGLE_OAUTH_CLIENT_SECRET_NAME,
  GOOGLE_OAUTH_STATE_SECRET_NAME,
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_REVOKE_URL,
  GoogleOAuthError,
  verifyGoogleOAuthState,
  createGoogleConsent,
  completeGoogleOAuthCallback,
  revokeGoogleConnection,
  type GoogleOAuthErrorCode,
  type GoogleOAuthDeps,
} from './google-oauth.js';
