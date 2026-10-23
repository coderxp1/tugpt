import { createHash } from 'node:crypto';

/**
 * Normalizes a Meta WhatsApp webhook envelope into individual message events.
 * Supports multiple entries and multiple message changes in a single envelope.
 */

export interface NormalizedWhatsAppEvent {
  providerConnectionIdentifier: string;
  providerMessageId: string;
  contactIdentifier: string;
  messageKind: string;
  bodyText: string | null;
  providerTimestamp: string | null;
  /**
   * The provider's id for the attached media, when there is any.
   *
   * Needed because a voice note cannot be transcribed from a message that says
   * only "this was audio" — something has to point at the bytes. Nothing
   * carried this before 20260903000008, which is why an audio message used to
   * arrive as a row with a NULL body and no way to do anything about it.
   *
   * DELIBERATELY ABSENT FROM computeCanonicalHash. See the note there.
   */
  mediaReference: string | null;
  mediaMimeType: string | null;
}

/**
 * Extracts individual message events from a Meta webhook payload.
 * Handles the nested entry -> changes -> value -> messages structure.
 */
export function normalizeWhatsAppEnvelope(payload: unknown): NormalizedWhatsAppEvent[] {
  const events: NormalizedWhatsAppEvent[] = [];

  if (!payload || typeof payload !== 'object') {
    return events;
  }

  const envelope = payload as Record<string, unknown>;
  const entries = envelope.entry;
  if (!Array.isArray(entries)) {
    return events;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;

    // Extract provider connection identifier (phone_number_id)
    const changes = entryObj.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const changeObj = change as Record<string, unknown>;
      const value = changeObj.value;
      if (!value || typeof value !== 'object') continue;
      const valueObj = value as Record<string, unknown>;

      // Get the phone_number_id (provider connection identifier)
      const metadata = valueObj.metadata;
      const providerConnectionIdentifier =
        metadata && typeof metadata === 'object'
          ? String((metadata as Record<string, unknown>).phone_number_id || '')
          : '';

      if (!providerConnectionIdentifier) continue;

      // Process messages array
      const messages = valueObj.messages;
      if (!Array.isArray(messages)) continue;

      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const msgObj = message as Record<string, unknown>;

        const providerMessageId = String(msgObj.id || '');
        if (!providerMessageId) continue;

        const from = String(msgObj.from || '');
        if (!from) continue;

        // Determine message kind and body
        let messageKind = 'text';
        let bodyText: string | null = null;

        if (msgObj.text && typeof msgObj.text === 'object') {
          messageKind = 'text';
          bodyText = String((msgObj.text as Record<string, unknown>).body || '');
        } else if (msgObj.type) {
          messageKind = String(msgObj.type);
          // For non-text messages, body may be null
          bodyText = null;
        }

        const providerTimestamp = msgObj.timestamp ? String(msgObj.timestamp) : null;

        // Meta nests media under a key named for the type: an audio message
        // carries `audio: { id, mime_type }`, an image `image: { id, ... }`,
        // and so on. Reading `msgObj[messageKind]` rather than checking each
        // type by name means a type this code has never heard of still yields
        // its media instead of silently dropping it.
        //
        // A text message has no such object, and `messageKind` is 'text', so
        // this resolves to undefined and both fields stay null.
        let mediaReference: string | null = null;
        let mediaMimeType: string | null = null;
        const mediaNode = msgObj[messageKind];
        if (mediaNode && typeof mediaNode === 'object') {
          const media = mediaNode as Record<string, unknown>;
          if (typeof media.id === 'string' && media.id.length > 0) {
            mediaReference = media.id;
          }
          if (typeof media.mime_type === 'string' && media.mime_type.length > 0) {
            mediaMimeType = media.mime_type;
          }
        }

        events.push({
          providerConnectionIdentifier,
          providerMessageId,
          contactIdentifier: from,
          messageKind,
          bodyText,
          providerTimestamp,
          mediaReference,
          mediaMimeType,
        });
      }
    }
  }

  return events;
}

/**
 * Computes a deterministic canonical hash for a normalized event.
 * Uses a versioned JSON array canonicalization.
 *
 * THE MEDIA REFERENCE IS NOT IN HERE, AND MUST NOT BE.
 *
 * This hash is the deduplication key for redelivered webhooks. Adding a field
 * changes the hash of every message, so a redelivery that straddled the deploy
 * would hash differently, miss the duplicate check, and be ingested twice —
 * which for an audio message would mean transcribing and billing it twice.
 *
 * It would also buy nothing: the media reference is a property of the message
 * the provider id already identifies, so it distinguishes no two events that
 * were not already distinct. A field that changes every key and separates
 * nothing is pure cost.
 *
 * If a field ever genuinely needs to join the key, the tag moves to
 * 'whatsapp-event-v2' and somebody decides what happens to in-flight
 * redeliveries. That is a migration, not an edit.
 */
export interface NormalizedWhatsAppStatus {
  /** The provider message id (wamid) of OUR outbound message. */
  providerMessageId: string;
  /** Meta's status vocabulary: sent | delivered | read | failed. */
  status: string;
  /** ISO timestamp of the provider event, when Meta sent one. */
  providerTimestamp: string | null;
}

/**
 * Extracts delivery status callbacks from a Meta webhook payload.
 *
 * Statuses live in the same entry -> changes -> value structure as
 * messages, in a sibling `statuses` array — they are NOT messages,
 * which is why the message normalizer above never sees them (and
 * why, before delivery receipts, they were acknowledged and
 * dropped). Parsing is defensive in the same style: anything
 * malformed is skipped, never thrown — a webhook handler that
 * throws on provider-shaped input earns itself a retry storm.
 */
export function extractWhatsAppStatuses(payload: unknown): NormalizedWhatsAppStatus[] {
  const statuses: NormalizedWhatsAppStatus[] = [];

  if (!payload || typeof payload !== 'object') {
    return statuses;
  }
  const entries = (payload as Record<string, unknown>).entry;
  if (!Array.isArray(entries)) {
    return statuses;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = (entry as Record<string, unknown>).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== 'object') continue;
      const rawStatuses = (value as Record<string, unknown>).statuses;
      if (!Array.isArray(rawStatuses)) continue;

      for (const raw of rawStatuses) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const id = item.id;
        const status = item.status;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (typeof status !== 'string' || status.length === 0) continue;

        let providerTimestamp: string | null = null;
        const ts = item.timestamp;
        if (typeof ts === 'string' || typeof ts === 'number') {
          const seconds = Number(ts);
          if (Number.isFinite(seconds) && seconds > 0) {
            providerTimestamp = new Date(seconds * 1000).toISOString();
          }
        }

        statuses.push({ providerMessageId: id, status, providerTimestamp });
      }
    }
  }

  return statuses;
}

export function computeCanonicalHash(event: {
  provider: string;
  providerConnectionIdentifier: string;
  providerMessageId: string;
  contactIdentifier: string;
  messageKind: string;
  bodyText: string | null;
  providerTimestamp: string | null;
}): string {
  const crypto = { createHash };

  // Normalize timestamp to integer Unix seconds
  let normalizedTimestamp: number | null = null;
  if (event.providerTimestamp) {
    const ts = parseInt(event.providerTimestamp, 10);
    if (!isNaN(ts)) {
      normalizedTimestamp = ts;
    }
  }

  const canonical = JSON.stringify([
    'whatsapp-event-v1',
    event.provider,
    event.providerConnectionIdentifier,
    event.providerMessageId,
    event.contactIdentifier,
    event.messageKind,
    event.bodyText,
    normalizedTimestamp,
  ]);

  return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf-8')).digest('hex');
}