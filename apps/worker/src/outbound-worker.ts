import { featureFlagService } from '@tugpt/feature-flags';
import type { OutboundDelivery, OutboundQueueAdapter } from './outbound-queue-adapter';
import { WhatsAppSendError, type WhatsAppSender } from './whatsapp-send';

/**
 * @file outbound-worker.ts
 * @description Drains the `outbound_deliveries` queue: one claimed
 * delivery in, one WhatsApp text out, one completion (or terminal
 * archive) recorded.
 *
 * THE GATE. Before anything is claimed, the `whatsapp_integration`
 * kill switch is consulted through @tugpt/feature-flags — the same
 * service the WhatsApp webhook route consults. The switch is
 * hardcoded `false` (ADR-010 amendment 2: enabling outbound WhatsApp
 * is an owner decision, made in code, not an engineering one). While
 * it is off this worker claims nothing and sends nothing. The test
 * seam on FeatureFlagService is how the fixture tests below the line
 * exercise the enabled path; production code never calls setFlag.
 *
 * FAILURE SEMANTICS
 *   - Meta 4xx (permanent): archive as OUTBOUND_PROVIDER_REJECTED on
 *     the first occurrence. The same body to the same number will be
 *     refused again.
 *   - Meta 5xx / network (transient): leave the delivery claimed-but-
 *     unfinished; PGMQ redelivers it after the visibility timeout.
 *     When the reconciled attempt count reaches the budget, archive
 *     as OUTBOUND_SEND_EXHAUSTED.
 *   - No access token provisioned for the connection: the send is not
 *     attempted. The delivery is deferred like a transient failure
 *     (and exhausts the same way) — a missing token is an operator
 *     problem the attempts counter makes visible in the table, not
 *     a reason to tell the customer nothing forever while reporting
 *     success.
 */

export interface OutboundWorkerDeps {
  queue: Pick<
    OutboundQueueAdapter,
    'readDeliveries' | 'completeDelivery' | 'archiveFailedDelivery'
  >;
  sender: Pick<WhatsAppSender, 'sendText'>;
  /** Returns the Meta access token for a connection, or null when none
   *  is provisioned. Provisioning is an owner-gated step; this worker
   *  never creates or stores tokens. */
  resolveAccessToken: (
    organizationId: string,
    whatsappConnectionId: string
  ) => Promise<string | null>;
  flags?: Pick<typeof featureFlagService, 'isEnabled'>;
  maxAttempts?: number;
  batchSize?: number;
}

export interface OutboundBatchSummary {
  gateOpen: boolean;
  claimed: number;
  sent: number;
  rejected: number;
  exhausted: number;
  deferred: number;
}

export const OUTBOUND_DEFAULT_MAX_ATTEMPTS = 5;

export class OutboundWorker {
  private readonly flags: Pick<typeof featureFlagService, 'isEnabled'>;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(private deps: OutboundWorkerDeps) {
    this.flags = deps.flags ?? featureFlagService;
    this.maxAttempts = deps.maxAttempts ?? OUTBOUND_DEFAULT_MAX_ATTEMPTS;
    this.batchSize = deps.batchSize ?? 5;
  }

  async processBatch(): Promise<OutboundBatchSummary> {
    const summary: OutboundBatchSummary = {
      gateOpen: false,
      claimed: 0,
      sent: 0,
      rejected: 0,
      exhausted: 0,
      deferred: 0,
    };

    if (!this.flags.isEnabled('whatsapp_integration')) {
      return summary;
    }
    summary.gateOpen = true;

    const deliveries = await this.deps.queue.readDeliveries(this.batchSize);
    summary.claimed = deliveries.length;

    for (const delivery of deliveries) {
      await this.processOne(delivery, summary);
    }
    return summary;
  }

  private async processOne(
    delivery: OutboundDelivery,
    summary: OutboundBatchSummary
  ): Promise<void> {
    const token = await this.deps.resolveAccessToken(
      delivery.organizationId,
      delivery.whatsappConnectionId
    );
    if (token === null) {
      await this.deferOrExhaust(delivery, summary);
      return;
    }

    try {
      const { providerMessageId } = await this.deps.sender.sendText({
        providerPhoneNumberId: delivery.providerPhoneNumberId,
        accessToken: token,
        to: delivery.recipientPhone,
        body: delivery.body,
      });
      await this.deps.queue.completeDelivery(
        delivery.deliveryId,
        delivery.organizationId,
        providerMessageId
      );
      summary.sent += 1;
    } catch (err) {
      if (err instanceof WhatsAppSendError && err.kind === 'permanent') {
        await this.deps.queue.archiveFailedDelivery(
          delivery.deliveryId,
          delivery.organizationId,
          'OUTBOUND_PROVIDER_REJECTED'
        );
        summary.rejected += 1;
        return;
      }
      await this.deferOrExhaust(delivery, summary);
    }
  }

  private async deferOrExhaust(
    delivery: OutboundDelivery,
    summary: OutboundBatchSummary
  ): Promise<void> {
    if (delivery.attempts >= this.maxAttempts) {
      await this.deps.queue.archiveFailedDelivery(
        delivery.deliveryId,
        delivery.organizationId,
        'OUTBOUND_SEND_EXHAUSTED'
      );
      summary.exhausted += 1;
    } else {
      summary.deferred += 1;
    }
  }
}
