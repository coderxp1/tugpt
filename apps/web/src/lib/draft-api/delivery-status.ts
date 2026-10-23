/**
 * Delivery status vocabulary shared by the delivery API routes and
 * the drafts UI.
 *
 * The database speaks its own statuses (outbound_message_deliveries.
 * status + error_code); the UI speaks five states a reviewer
 * understands. This module is the only translation between them, so
 * the API and the badges can never drift apart:
 *
 *   queued                       -> queued   (waiting for the worker)
 *   processing                   -> sending  (claimed, send in flight)
 *   sent                         -> sent     (Meta accepted it; the
 *                                            provider message id is
 *                                            on the delivery)
 *   dead_lettered + OUTBOUND_PROVIDER_REJECTED -> rejected
 *                                            (Meta refused it
 *                                            permanently — retrying
 *                                            the same text cannot
 *                                            succeed)
 *   dead_lettered + anything else -> failed (the attempt budget was
 *                                            exhausted)
 *   cancelled                    -> failed   (never sent; shown as a
 *                                            failure, not a success)
 *
 * A draft with no delivery row has no delivery status at all — the
 * UI shows nothing, rather than inventing a state.
 */

export type DeliveryDisplayStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'rejected';

export interface DeliveryRow {
  id: string;
  draft_id: string;
  status: string;
  provider_message_id: string | null;
  attempts: number;
  error_code: string | null;
  updated_at: string;
  /** Receipt columns (20261022000005); absent on rows read by older code paths. */
  delivered_at?: string | null;
  read_at?: string | null;
}

export interface DeliveryView {
  id: string;
  status: DeliveryDisplayStatus;
  providerMessageId: string | null;
  attempts: number;
  errorCode: string | null;
  updatedAt: string;
  /** Provider receipt times (20261022000005); null until Meta reports them. */
  deliveredAt: string | null;
  readAt: string | null;
}

export function toDeliveryView(row: DeliveryRow): DeliveryView {
  let status: DeliveryDisplayStatus;
  switch (row.status) {
    case 'queued':
      status = 'queued';
      break;
    case 'processing':
      status = 'sending';
      break;
    case 'sent':
      status = 'sent';
      break;
    case 'dead_lettered':
      status =
        row.error_code === 'OUTBOUND_PROVIDER_REJECTED' ? 'rejected' : 'failed';
      break;
    default:
      status = 'failed';
  }
  return {
    id: row.id,
    status,
    providerMessageId: row.provider_message_id,
    attempts: row.attempts,
    errorCode: row.error_code,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at ?? null,
    readAt: row.read_at ?? null,
  };
}
