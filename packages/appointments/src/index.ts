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
