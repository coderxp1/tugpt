import { describe, expect, it, vi } from 'vitest';
import { WhatsAppSendError, WhatsAppSender } from '../src/whatsapp-send';

/**
 * The sender's wire contract with Meta's Graph API: where the request
 * goes, what it carries, and how failures are classified. The worker's
 * retry semantics depend on the permanent/transient split, so it is
 * pinned here rather than inferred.
 */

function senderWith(fetchImpl: unknown) {
  return new WhatsAppSender({ fetchImpl: fetchImpl as never });
}

const REQUEST = {
  providerPhoneNumberId: '1234567890',
  accessToken: 'secret-token',
  to: '+34611223344',
  body: 'Sí, mañana a las 10:00.',
};

describe('WhatsAppSender', () => {
  it('posts a text message to the connection number and returns the message id', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.ABC' }] }),
    }));

    const result = await senderWith(fetchImpl).sendText(REQUEST);

    expect(result.providerMessageId).toBe('wamid.ABC');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+34611223344',
      type: 'text',
      text: { body: 'Sí, mañana a las 10:00.' },
    });
  });

  it('classifies a 4xx refusal as permanent', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad request' } }),
    }));

    await expect(senderWith(fetchImpl).sendText(REQUEST)).rejects.toMatchObject({
      name: 'WhatsAppSendError',
      kind: 'permanent',
      status: 400,
    });
  });

  it('classifies a 5xx as transient', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    await expect(senderWith(fetchImpl).sendText(REQUEST)).rejects.toMatchObject({
      name: 'WhatsAppSendError',
      kind: 'transient',
    } as Partial<WhatsAppSendError>);
  });

  it('classifies a network failure as transient', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    await expect(senderWith(fetchImpl).sendText(REQUEST)).rejects.toMatchObject({
      name: 'WhatsAppSendError',
      kind: 'transient',
    });
  });

  it('treats a 200 without a message id as transient, never as sent', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
    }));

    await expect(senderWith(fetchImpl).sendText(REQUEST)).rejects.toMatchObject({
      name: 'WhatsAppSendError',
      kind: 'transient',
    });
  });
});
