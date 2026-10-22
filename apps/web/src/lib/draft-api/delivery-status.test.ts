import { describe, expect, it } from 'vitest';
import { toDeliveryView, type DeliveryRow } from './delivery-status';

function row(overrides: Partial<DeliveryRow>): DeliveryRow {
  return {
    id: 'del-1',
    draft_id: 'draft-1',
    status: 'queued',
    provider_message_id: null,
    attempts: 0,
    error_code: null,
    updated_at: '2026-10-22T00:00:00Z',
    ...overrides,
  };
}

describe('toDeliveryView', () => {
  it('maps queued to queued', () => {
    expect(toDeliveryView(row({ status: 'queued' })).status).toBe('queued');
  });

  it('maps processing to sending', () => {
    expect(toDeliveryView(row({ status: 'processing' })).status).toBe('sending');
  });

  it('maps sent to sent and carries the provider message id', () => {
    const view = toDeliveryView(
      row({ status: 'sent', provider_message_id: 'wamid.123', attempts: 1 })
    );
    expect(view.status).toBe('sent');
    expect(view.providerMessageId).toBe('wamid.123');
    expect(view.attempts).toBe(1);
  });

  it('maps a permanent provider refusal to rejected', () => {
    const view = toDeliveryView(
      row({ status: 'dead_lettered', error_code: 'OUTBOUND_PROVIDER_REJECTED' })
    );
    expect(view.status).toBe('rejected');
    expect(view.errorCode).toBe('OUTBOUND_PROVIDER_REJECTED');
  });

  it('maps retry exhaustion to failed', () => {
    const view = toDeliveryView(
      row({ status: 'dead_lettered', error_code: 'OUTBOUND_SEND_EXHAUSTED', attempts: 5 })
    );
    expect(view.status).toBe('failed');
  });

  it('maps cancelled and unknown states to failed, never to a success state', () => {
    expect(toDeliveryView(row({ status: 'cancelled' })).status).toBe('failed');
    expect(toDeliveryView(row({ status: 'something-else' })).status).toBe('failed');
  });
});
