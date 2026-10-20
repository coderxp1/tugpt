/**
 * A hook for recording what an availability read did.
 *
 * Phase 3 requires an audit trail, and this slice cannot write to a database
 * (no migrations are in scope). An observer is the seam: the service reports
 * every outcome through it, and a later slice supplies an implementation that
 * persists. Nothing here mutates anything — an observer that throws is
 * contained, because an audit sink must never be able to break a read.
 */

import type { AvailabilityFailureReason } from './provider.js';

/** Everything an availability read can report. */
export type AvailabilityReadEvent =
  | {
      readonly outcome: 'ok';
      readonly provider: string;
      /** Slots returned to the caller. */
      readonly returned: number;
      /** Slots the provider sent that were rejected by normalisation. */
      readonly dropped: number;
    }
  | {
      readonly outcome: 'invalid_request' | 'provider_failed' | 'provider_threw';
      readonly provider: string;
      readonly reason: AvailabilityFailureReason;
      readonly detail: string;
    };

export interface AvailabilityObserver {
  onRead(event: AvailabilityReadEvent): void;
}

/**
 * Call `observer.onRead`, swallowing anything it raises.
 *
 * Deliberately narrow: a broken audit sink degrades observability, and
 * degrading observability must never degrade the customer's answer.
 */
export function recordAvailabilityRead(
  observer: AvailabilityObserver,
  event: AvailabilityReadEvent
): void {
  try {
    observer.onRead(event);
  } catch {
    // Intentionally ignored — see above.
  }
}
