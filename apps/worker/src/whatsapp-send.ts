/**
 * @file whatsapp-send.ts
 * @description Sends one outbound WhatsApp text message through Meta's
 * Graph API. This is the ONLY module in the worker that may reference
 * the send endpoint or POST to a Graph host — the outbound-gate test
 * asserts exactly that confinement, and asserts that the transcription
 * path (whatsapp-media.ts) remains GET-only.
 *
 * WHY THIS EXISTS, AND WHAT STILL GOVERNS IT
 *
 * Until 2026-10-22 the worker could not send at all: the 2026-09-04
 * approval for the media-download client was explicit that it did not
 * open outbound messaging. The owner's 2026-10-22 product mandate
 * directs building the delivery path for human-approved drafts
 * (migration 20261022000001). Building the path is not enabling it:
 * the `whatsapp_integration` kill switch in @tugpt/feature-flags
 * remains hardcoded `false` (ADR-010 amendment 2 — enabling outbound
 * WhatsApp is an owner decision), and outbound-worker.ts refuses to
 * claim or send anything while it is off. This module is therefore
 * unreachable in production until the owner lifts the switch in code,
 * the database row exists, and a Meta access token is provisioned for
 * the organization's connection.
 *
 * The Graph version is pinned, as in whatsapp-media.ts, so a Meta
 * default change cannot alter response shapes under us.
 */

export const WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
export const WHATSAPP_GRAPH_VERSION = 'v21.0';

export interface WhatsAppSendRequest {
  providerPhoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}

export interface WhatsAppSendResult {
  providerMessageId: string;
}

export type WhatsAppSendErrorKind = 'permanent' | 'transient';

/**
 * permanent — Meta refused the message with a 4xx (bad number, bad
 * template-less body outside the 24h window, revoked token): retrying
 * the same send cannot succeed, the delivery is archived as
 * OUTBOUND_PROVIDER_REJECTED.
 * transient — 5xx or a network failure: the delivery is left for
 * PGMQ redelivery until the attempt budget is spent
 * (OUTBOUND_SEND_EXHAUSTED).
 */
export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly kind: WhatsAppSendErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

type FetchLike = (
  url: string,
  init: Record<string, unknown>
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export class WhatsAppSender {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly version: string;

  constructor(deps: { fetchImpl?: FetchLike; baseUrl?: string; version?: string } = {}) {
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = deps.baseUrl ?? WHATSAPP_GRAPH_BASE_URL;
    this.version = deps.version ?? WHATSAPP_GRAPH_VERSION;
  }

  async sendText(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
    const url =
      `${this.baseUrl}/${this.version}/` +
      `${encodeURIComponent(request.providerPhoneNumberId)}/messages`;

    let response: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: request.to,
          type: 'text',
          text: { body: request.body },
        }),
      });
    } catch (err) {
      throw new WhatsAppSendError(
        `WhatsApp send failed before a response: ${err instanceof Error ? err.message : String(err)}`,
        'transient'
      );
    }

    if (!response.ok) {
      const kind: WhatsAppSendErrorKind =
        response.status >= 400 && response.status < 500 ? 'permanent' : 'transient';
      throw new WhatsAppSendError(
        `WhatsApp send refused with HTTP ${response.status}`,
        kind,
        response.status
      );
    }

    const payload = (await response.json()) as {
      messages?: Array<{ id?: unknown }>;
    };
    const providerMessageId = payload.messages?.[0]?.id;
    if (typeof providerMessageId !== 'string' || providerMessageId.length === 0) {
      throw new WhatsAppSendError(
        'WhatsApp send returned no message id',
        'transient',
        response.status
      );
    }
    return { providerMessageId };
  }
}
