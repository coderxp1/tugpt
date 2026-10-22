import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@tugpt/security';
import { createAdminSupabaseClient } from '@tugpt/database';
import { featureFlagService } from '@tugpt/feature-flags';
import { normalizeWhatsAppEnvelope, computeCanonicalHash, extractWhatsAppStatuses } from '@/lib/whatsapp-normalizer';
import { defaultLogger } from '@tugpt/observability';
import { readSecret, reportMissingSecret } from '@/lib/whatsapp-webhook-secrets';

// Read per request, not at module load: see the header of
// `@/lib/whatsapp-webhook-secrets` for why both of these stopped being
// `process.env.X || ''` constants.
function maxBodySizeBytes(): number {
  return parseInt(process.env.WHATSAPP_MAX_BODY_SIZE_BYTES || '1048576', 10);
}

// GET: Webhook verification
export async function GET(request: NextRequest) {
  if (!featureFlagService.isEnabled('whatsapp_integration')) {
    return new NextResponse(null, { status: 404 });
  }

  const verifyToken = readSecret('WHATSAPP_VERIFY_TOKEN', process.env.WHATSAPP_VERIFY_TOKEN);
  if (!verifyToken.ok) {
    // 403, the same answer a wrong token gets. A caller probing this endpoint
    // learns nothing about whether the server is configured; the operator
    // learns everything, from the log line.
    //
    // Without this, an absent token became '' and `?hub.verify_token=` matched
    // it — handing Meta's verification handshake to anyone who asked.
    reportMissingSecret(verifyToken.reason);
    return new NextResponse(null, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === verifyToken.value) {
    return new NextResponse(challenge || '', { status: 200 });
  }

  return new NextResponse(null, { status: 403 });
}

// POST: Webhook event ingestion
export async function POST(request: NextRequest) {
  if (!featureFlagService.isEnabled('whatsapp_integration')) {
    return new NextResponse(null, { status: 404 });
  }

  const appSecret = readSecret('WHATSAPP_APP_SECRET', process.env.WHATSAPP_APP_SECRET);
  if (!appSecret.ok) {
    // 401, the same answer a forged signature gets: this request cannot be
    // authenticated. It is checked before the body is read, because a request
    // that cannot be authenticated should not be parsed, sized, or hashed.
    //
    // Without this, an absent secret became '' and `verifySignature` keyed the
    // HMAC on the empty string — a signature anyone can compute. Every forged
    // payload would have entered ingestion as a genuine customer message.
    // `verifySignature` now refuses a blank secret too; this is the caller-side
    // half, and it is here so the refusal happens before the work does.
    reportMissingSecret(appSecret.reason);
    return new NextResponse(null, { status: 401 });
  }

  // Validate content type
  const contentType = request.headers.get('content-type') || '';
  const parsedContentType = contentType.split(';')[0].trim();
  if (parsedContentType !== 'application/json') {
    return new NextResponse(null, { status: 415 });
  }

  // Read raw body
  let rawBody: Buffer;
  try {
    const text = await request.text();
    rawBody = Buffer.from(text, 'utf-8');
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // Validate body size
  if (rawBody.length > maxBodySizeBytes()) {
    return new NextResponse(null, { status: 413 });
  }

  // Validate signature
  const signatureHeader = request.headers.get('x-hub-signature-256');
  if (!signatureHeader) {
    return new NextResponse(null, { status: 401 });
  }

  if (!verifySignature(rawBody, signatureHeader, appSecret.value)) {
    return new NextResponse(null, { status: 401 });
  }

  // Parse JSON
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // Normalize envelope into individual events
  const events = normalizeWhatsAppEnvelope(payload);
  // Delivery status callbacks (delivered / read / failed for OUR
  // outbound messages) ride the same envelope in a sibling array.
  const statuses = extractWhatsAppStatuses(payload);
  if (events.length === 0 && statuses.length === 0) {
    // Valid but unsupported event: acknowledge without persistence
    return new NextResponse(null, { status: 200 });
  }

  // Create admin client for RPC calls
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return new NextResponse(null, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminClient = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as any;

  // Ingest each event independently
  const requestId = request.headers.get('x-request-id') || null;
  for (const event of events) {
    const canonicalHash = computeCanonicalHash({
      provider: 'meta',
      providerConnectionIdentifier: event.providerConnectionIdentifier,
      providerMessageId: event.providerMessageId,
      contactIdentifier: event.contactIdentifier,
      messageKind: event.messageKind,
      bodyText: event.bodyText,
      providerTimestamp: event.providerTimestamp,
    });

    const { error } = await adminClient.rpc('ingest_whatsapp_message_event', {
      p_provider_connection_identifier: event.providerConnectionIdentifier,
      p_provider: 'meta',
      p_provider_event_key: event.providerMessageId,
      p_event_kind: 'message',
      p_payload_sha256: canonicalHash,
      p_provider_message_id: event.providerMessageId,
      p_contact_identifier: event.contactIdentifier,
      p_message_kind: event.messageKind,
      p_body_text: event.bodyText,
      p_media_reference: event.mediaReference,
      p_media_mime_type: event.mediaMimeType,
      p_provider_timestamp: event.providerTimestamp,
      p_request_id: requestId,
    });

    if (error) {
      // Any ingestion failure: return 500 for Meta retry
      return new NextResponse(null, { status: 500 });
    }
  }

  // Apply delivery receipts. Unlike message ingestion, a receipt
  // failure must NOT fail the webhook: receipts only refine the
  // record of a send that already happened (the send result is the
  // floor of truth), Meta retries whole payloads on a 500, and the
  // receipt RPC is idempotent and monotonic, so a later callback
  // converges the state. Failures and unknown ids are logged with
  // the provider message id and status only — never payload bodies.
  for (const status of statuses) {
    const { data: applied, error: receiptError } = await adminClient.rpc(
      'record_outbound_delivery_receipt',
      {
        p_provider_message_id: status.providerMessageId,
        p_status: status.status,
        p_event_at: status.providerTimestamp,
      }
    );

    if (receiptError) {
      defaultLogger.warn('Delivery receipt RPC failed', {
        requestId: requestId ?? undefined,
        providerMessageId: status.providerMessageId,
        receiptStatus: status.status,
        sqlstateCode: receiptError.code,
      });
    } else if (applied === false) {
      defaultLogger.warn('Delivery receipt not applied (unknown id or status)', {
        requestId: requestId ?? undefined,
        providerMessageId: status.providerMessageId,
        receiptStatus: status.status,
      });
    }
  }

  return new NextResponse(null, { status: 200 });
}