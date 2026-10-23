import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * @file outbound-queue-adapter.ts
 * @description PGMQ adapter for the `outbound_deliveries` queue
 * (migration 20261022000001). Same shape as the transcription and
 * media adapters: every operation goes through a service-role RPC;
 * nothing here touches the `pgmq` schema directly.
 */

export interface OutboundDelivery {
  deliveryId: string;
  organizationId: string;
  draftId: string;
  conversationId: string;
  whatsappConnectionId: string;
  providerPhoneNumberId: string;
  recipientPhone: string;
  body: string;
  attempts: number;
  pgmqMsgId: number;
}

export const OUTBOUND_DEFAULT_VISIBILITY_SECONDS = 120;

interface OutboundDeliveryRow {
  delivery_id: string;
  organization_id: string;
  draft_id: string;
  conversation_id: string;
  whatsapp_connection_id: string;
  provider_phone_number_id: string;
  recipient_phone: string;
  body: string;
  attempts: number;
  pgmq_msg_id: number;
}

export class OutboundQueueAdapter {
  constructor(private client: SupabaseClient) {}

  /**
   * Claim deliveries. The RPC reconciles `attempts` to PGMQ's read_ct
   * and archives messages whose delivery already reached a terminal
   * state, so a row returned here is always an unsent delivery.
   */
  async readDeliveries(
    limit = 5,
    visibilityTimeoutSeconds = OUTBOUND_DEFAULT_VISIBILITY_SECONDS
  ): Promise<OutboundDelivery[]> {
    const { data, error } = await this.client.rpc('read_outbound_deliveries', {
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      p_qty: limit,
    });
    if (error) {
      throw new Error(`read_outbound_deliveries failed: ${error.message}`);
    }
    return ((data ?? []) as OutboundDeliveryRow[]).map((row) => ({
      deliveryId: row.delivery_id,
      organizationId: row.organization_id,
      draftId: row.draft_id,
      conversationId: row.conversation_id,
      whatsappConnectionId: row.whatsapp_connection_id,
      providerPhoneNumberId: row.provider_phone_number_id,
      recipientPhone: row.recipient_phone,
      body: row.body,
      attempts: row.attempts,
      pgmqMsgId: row.pgmq_msg_id,
    }));
  }

  async completeDelivery(
    deliveryId: string,
    organizationId: string,
    providerMessageId: string
  ): Promise<void> {
    const { error } = await this.client.rpc('complete_outbound_delivery', {
      p_delivery_id: deliveryId,
      p_organization_id: organizationId,
      p_provider_message_id: providerMessageId,
    });
    if (error) {
      throw new Error(`complete_outbound_delivery failed: ${error.message}`);
    }
  }

  async archiveFailedDelivery(
    deliveryId: string,
    organizationId: string,
    errorCode: 'OUTBOUND_SEND_EXHAUSTED' | 'OUTBOUND_PROVIDER_REJECTED'
  ): Promise<void> {
    const { error } = await this.client.rpc('archive_outbound_failed_delivery', {
      p_delivery_id: deliveryId,
      p_organization_id: organizationId,
      p_error_code: errorCode,
    });
    if (error) {
      throw new Error(`archive_outbound_failed_delivery failed: ${error.message}`);
    }
  }
}
