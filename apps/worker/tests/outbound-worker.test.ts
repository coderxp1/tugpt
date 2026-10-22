import { describe, expect, it, vi } from 'vitest';
import { FeatureFlagService } from '@tugpt/feature-flags';
import type { OutboundDelivery } from '../src/outbound-queue-adapter';
import { OutboundWorker } from '../src/outbound-worker';
import { WhatsAppSendError } from '../src/whatsapp-send';

/**
 * The outbound worker's contract, in the order an operator cares:
 *
 *   1. With the kill switch off — its production state — it claims
 *      nothing and sends nothing. This is the property that makes
 *      shipping the delivery path safe before the owner enables it.
 *   2. With the switch on (test seam only), a claimed delivery is sent
 *      once and completed with Meta's message id.
 *   3. A permanent Meta refusal archives the delivery as rejected on
 *      the first attempt; a transient failure defers it for PGMQ
 *      redelivery and archives it as exhausted only at the budget.
 *   4. A connection with no provisioned token is never sent to; the
 *      delivery defers (and eventually exhausts) instead of silently
 *      vanishing or falsely completing.
 */

const DELIVERY: OutboundDelivery = {
  deliveryId: '11111111-2222-3333-4444-555555555555',
  organizationId: 'aaaaaaaa-0000-0000-0000-000000000001',
  draftId: 'dddddddd-0000-0000-0000-000000000001',
  conversationId: 'cccccccc-0000-0000-0000-000000000001',
  whatsappConnectionId: 'bbbbbbbb-0000-0000-0000-000000000001',
  providerPhoneNumberId: 'conn-out-a',
  recipientPhone: '+34611223344',
  body: 'Sí, mañana a las 10:00.',
  attempts: 1,
  pgmqMsgId: 42,
};

function enabledFlags(): FeatureFlagService {
  const flags = new FeatureFlagService();
  flags.setFlag('whatsapp_integration', true); // test seam, by design
  return flags;
}

function makeWorker(overrides: Partial<Parameters<typeof OutboundWorker>[0]> = {}) {
  const queue = {
    readDeliveries: vi.fn(async () => [DELIVERY]),
    completeDelivery: vi.fn(async () => undefined),
    archiveFailedDelivery: vi.fn(async () => undefined),
  };
  const sender = {
    sendText: vi.fn(async () => ({ providerMessageId: 'wamid.TEST' })),
  };
  const deps = {
    queue,
    sender,
    resolveAccessToken: async () => 'test-token',
    flags: enabledFlags(),
    ...overrides,
  };
  const worker = new OutboundWorker(deps);
  return {
    worker,
    queue: deps.queue as typeof queue,
    sender: deps.sender as typeof sender,
  };
}

describe('OutboundWorker', () => {
  it('claims and sends nothing while the kill switch is off', async () => {
    const { worker, queue, sender } = makeWorker({
      flags: new FeatureFlagService(), // production state: hardcoded false
    });

    const summary = await worker.processBatch();

    expect(summary.gateOpen).toBe(false);
    expect(summary.claimed).toBe(0);
    expect(queue.readDeliveries).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('sends a claimed delivery once and completes it with the provider id', async () => {
    const { worker, queue, sender } = makeWorker();

    const summary = await worker.processBatch();

    expect(summary).toMatchObject({ gateOpen: true, claimed: 1, sent: 1 });
    expect(sender.sendText).toHaveBeenCalledWith({
      providerPhoneNumberId: 'conn-out-a',
      accessToken: 'test-token',
      to: '+34611223344',
      body: 'Sí, mañana a las 10:00.',
    });
    expect(queue.completeDelivery).toHaveBeenCalledWith(
      DELIVERY.deliveryId,
      DELIVERY.organizationId,
      'wamid.TEST'
    );
    expect(queue.archiveFailedDelivery).not.toHaveBeenCalled();
  });

  it('archives a permanent Meta refusal as rejected on the first attempt', async () => {
    const { worker, queue } = makeWorker({
      sender: {
        sendText: vi.fn(async () => {
          throw new WhatsAppSendError('refused', 'permanent', 400);
        }),
      },
    });

    const summary = await worker.processBatch();

    expect(summary.rejected).toBe(1);
    expect(queue.archiveFailedDelivery).toHaveBeenCalledWith(
      DELIVERY.deliveryId,
      DELIVERY.organizationId,
      'OUTBOUND_PROVIDER_REJECTED'
    );
    expect(queue.completeDelivery).not.toHaveBeenCalled();
  });

  it('defers a transient failure below the attempt budget', async () => {
    const { worker, queue } = makeWorker({
      sender: {
        sendText: vi.fn(async () => {
          throw new WhatsAppSendError('unavailable', 'transient', 503);
        }),
      },
    });

    const summary = await worker.processBatch();

    expect(summary.deferred).toBe(1);
    expect(queue.completeDelivery).not.toHaveBeenCalled();
    expect(queue.archiveFailedDelivery).not.toHaveBeenCalled();
  });

  it('archives a transient failure as exhausted at the attempt budget', async () => {
    const { worker, queue } = makeWorker({
      queue: {
        readDeliveries: vi.fn(async () => [{ ...DELIVERY, attempts: 5 }]),
        completeDelivery: vi.fn(async () => undefined),
        archiveFailedDelivery: vi.fn(async () => undefined),
      },
      sender: {
        sendText: vi.fn(async () => {
          throw new WhatsAppSendError('unavailable', 'transient', 503);
        }),
      },
    });

    const summary = await worker.processBatch();

    expect(summary.exhausted).toBe(1);
    expect(queue.archiveFailedDelivery).toHaveBeenCalledWith(
      DELIVERY.deliveryId,
      DELIVERY.organizationId,
      'OUTBOUND_SEND_EXHAUSTED'
    );
  });

  it('never sends for a connection with no provisioned token', async () => {
    const { worker, queue, sender } = makeWorker({
      resolveAccessToken: async () => null,
    });

    const summary = await worker.processBatch();

    expect(summary.deferred).toBe(1);
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(queue.completeDelivery).not.toHaveBeenCalled();
  });
});
