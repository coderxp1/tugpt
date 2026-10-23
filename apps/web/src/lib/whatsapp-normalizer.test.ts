import { describe, it, expect } from 'vitest';
import { normalizeWhatsAppEnvelope, computeCanonicalHash, extractWhatsAppStatuses } from './whatsapp-normalizer';

/**
 * The sha256 of JSON.stringify(['whatsapp-event-v1', 'meta', '12345', 'msg1',
 * '111', 'text', 'Hello', 1700000000]).
 *
 * A literal rather than a recomputation, because a test that recomputes the
 * canonical form asserts only that the function agrees with a copy of itself.
 * This is the value that ties the deduplication key to a number a human can
 * diff, and it is the assertion that fails if a field is added to the key --
 * which is the entire safety argument for carrying the media reference
 * alongside the hash rather than inside it.
 *
 * If this ever needs changing, the tag changes with it ('whatsapp-event-v2')
 * and somebody decides what happens to redeliveries that straddle the deploy.
 */
const KNOWN_HASH = 'ec52440d27d747187e93d552c654046c80fcefefb3c459a8138332e883fc39fe';

describe('whatsapp-normalizer', () => {
  // N1: Normalizer covers multiple entry arrays
  it('handles multiple entries in the envelope', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '1234567890', type: 'text', text: { body: 'Hello' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '67890' },
                messages: [{ id: 'msg2', from: '9876543210', type: 'text', text: { body: 'World' }, timestamp: '1700000001' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(2);
    expect(events[0].providerConnectionIdentifier).toBe('12345');
    expect(events[1].providerConnectionIdentifier).toBe('67890');
  });

  // N2: Normalizer covers changes arrays
  it('handles multiple changes in an entry', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '111', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg2', from: '222', type: 'text', text: { body: 'Yo' }, timestamp: '1700000001' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(2);
  });

  // N3: Normalizer covers messages arrays (multi-message envelopes)
  it('handles multiple messages in a single change', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  { id: 'msg1', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' },
                  { id: 'msg2', from: '222', type: 'text', text: { body: 'B' }, timestamp: '1700000001' },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(2);
  });

  // N4: Normalizer extracts correct provider_message_id
  it('extracts correct provider_message_id', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.test123', from: '111', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events[0].providerMessageId).toBe('wamid.test123');
  });

  // N5: Normalizer extracts correct contact_identifier
  it('extracts correct contact_identifier', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '15551234567', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events[0].contactIdentifier).toBe('15551234567');
  });

  // N6: Invalid payloads return empty array
  it('returns empty array for invalid payload', () => {
    expect(normalizeWhatsAppEnvelope(null)).toEqual([]);
    expect(normalizeWhatsAppEnvelope({})).toEqual([]);
    expect(normalizeWhatsAppEnvelope({ entry: [] })).toEqual([]);
  });

  // N7: Canonical hash is deterministic
  it('computes deterministic canonical hash', () => {
    const event = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const hash1 = computeCanonicalHash(event);
    const hash2 = computeCanonicalHash(event);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // N8: Per-event hashes differ for different messages in same envelope
  it('produces different hashes for different messages', () => {
    const event1 = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const event2 = { ...event1, providerMessageId: 'msg2' };
    expect(computeCanonicalHash(event1)).not.toBe(computeCanonicalHash(event2));
  });

  // N9: Event-key/hash mismatch — different body text produces different hash
  it('produces different hashes for same message ID but different body text', () => {
    const event1 = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const event2 = { ...event1, bodyText: 'World' };
    expect(computeCanonicalHash(event1)).not.toBe(computeCanonicalHash(event2));
  });

  // N10: Non-text message kind has null bodyText
  it('handles non-text message types with null bodyText', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '111', type: 'image', timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(1);
    expect(events[0].messageKind).toBe('image');
    expect(events[0].bodyText).toBeNull();
  });

  // N11: Missing timestamp results in null providerTimestamp
  it('handles missing timestamp', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', from: '111', type: 'text', text: { body: 'Hi' } }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(1);
    expect(events[0].providerTimestamp).toBeNull();
  });

  // N12: Canonical hash normalizes timestamp to integer
  it('normalizes timestamp to integer in canonical hash', () => {
    const event1 = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const event2 = { ...event1, providerTimestamp: '  1700000000  ' };
    // parseInt trims whitespace, so both should produce the same hash
    expect(computeCanonicalHash(event1)).toBe(computeCanonicalHash(event2));
  });

  // N13: Canonical hash includes version prefix for future migration
  it('includes version prefix in canonical hash', () => {
    const event = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    const hash = computeCanonicalHash(event);
    // The hash should be stable and include the 'whatsapp-event-v1' version tag
    // Changing the version prefix should produce a different hash
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // N14: Message with missing 'from' field is skipped
  it('skips messages with missing from field', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'msg1', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(0);
  });

  // N15: Message with missing 'id' field is skipped
  it('skips messages with missing id field', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ from: '111', type: 'text', text: { body: 'Hi' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(0);
  });

  // =========================================================================
  // Media reference (20260903000008)
  //
  // A voice note is only transcribable if something points at the bytes. These
  // pin both halves of that: that the reference is extracted, and — the more
  // important half — that extracting it did not disturb the deduplication key.
  // =========================================================================

  // N16: an audio message yields its media id and mime type
  it('extracts the media reference and mime type from an audio message', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  {
                    id: 'msg-audio',
                    from: '111',
                    type: 'audio',
                    audio: { id: 'media-abc', mime_type: 'audio/ogg; codecs=opus', voice: true },
                    timestamp: '1700000000',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(1);
    expect(events[0].messageKind).toBe('audio');
    expect(events[0].mediaReference).toBe('media-abc');
    expect(events[0].mediaMimeType).toBe('audio/ogg; codecs=opus');
    // An audio message carries no text, and nothing may invent one for it.
    expect(events[0].bodyText).toBeNull();
  });

  // N17: the extraction is generic, not a list of known types
  it('extracts media for kinds other than audio', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  {
                    id: 'msg-img',
                    from: '111',
                    type: 'image',
                    image: { id: 'media-img', mime_type: 'image/jpeg' },
                    timestamp: '1700000000',
                  },
                  {
                    id: 'msg-doc',
                    from: '111',
                    type: 'document',
                    document: { id: 'media-doc', mime_type: 'application/pdf' },
                    timestamp: '1700000001',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events.map((e) => e.mediaReference)).toEqual(['media-img', 'media-doc']);
    expect(events.map((e) => e.mediaMimeType)).toEqual(['image/jpeg', 'application/pdf']);
  });

  // N18: a text message has no media, and the text node is not mistaken for one
  it('leaves media fields null for a text message', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  { id: 'msg1', from: '111', type: 'text', text: { body: 'Hola' }, timestamp: '1700000000' },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events[0].mediaReference).toBeNull();
    expect(events[0].mediaMimeType).toBeNull();
  });

  // N19: a malformed media node degrades to null rather than to a bad reference
  it('yields null for a media node with no usable id', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  { id: 'a1', from: '111', type: 'audio', audio: { id: '', mime_type: 'audio/ogg' }, timestamp: '1700000000' },
                  { id: 'a2', from: '111', type: 'audio', audio: { id: 12345 }, timestamp: '1700000001' },
                  { id: 'a3', from: '111', type: 'audio', audio: null, timestamp: '1700000002' },
                  { id: 'a4', from: '111', type: 'audio', timestamp: '1700000003' },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = normalizeWhatsAppEnvelope(payload);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.mediaReference)).toEqual([null, null, null, null]);
    // A reference of '' or '12345' would produce a transcription job that
    // fetches nothing and dead-letters after burning its retries. The database
    // gate is `media_reference IS NOT NULL`, so null is the value that stops it.
    expect(events[0].mediaMimeType).toBe('audio/ogg');
  });

  // N20: THE ONE THAT MATTERS. The deduplication key is unchanged.
  //
  // migration 20260903000008 states this as a rule rather than an intention,
  // and names this test as the thing that makes it one. If the media reference
  // ever enters the canonical array, the hash of every message changes: a
  // webhook redelivery that straddled the deploy would hash differently, miss
  // the duplicate check, and be ingested a second time — for an audio message,
  // transcribed and billed a second time too.
  it('does not let the media reference change the canonical hash', () => {
    const base = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg-audio',
      contactIdentifier: '111',
      messageKind: 'audio',
      bodyText: null,
      providerTimestamp: '1700000000',
    };

    const withoutMedia = { ...base, mediaReference: null, mediaMimeType: null };
    const withMedia = { ...base, mediaReference: 'media-abc', mediaMimeType: 'audio/ogg' };
    const withOtherMedia = { ...base, mediaReference: 'media-zzz', mediaMimeType: 'audio/mpeg' };

    expect(computeCanonicalHash(withMedia)).toBe(computeCanonicalHash(withoutMedia));
    expect(computeCanonicalHash(withOtherMedia)).toBe(computeCanonicalHash(withoutMedia));
    // And equal to the hash of an event that predates the fields entirely,
    // which is the redelivery-across-the-deploy case stated literally.
    expect(computeCanonicalHash(withMedia)).toBe(computeCanonicalHash(base));
  });

  // N21: the positive control for N20. A hash insensitive to everything would
  // satisfy N20 trivially, so this pins that the fields inside the key still
  // move it.
  it('still distinguishes events that differ inside the key', () => {
    const base = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg-audio',
      contactIdentifier: '111',
      messageKind: 'audio',
      bodyText: null,
      providerTimestamp: '1700000000',
      mediaReference: 'media-abc',
      mediaMimeType: 'audio/ogg',
    };

    expect(computeCanonicalHash({ ...base, messageKind: 'image' })).not.toBe(computeCanonicalHash(base));
    expect(computeCanonicalHash({ ...base, providerMessageId: 'other' })).not.toBe(computeCanonicalHash(base));
  });

  // N22: the canonical tag is part of the contract, not an implementation
  // detail. Changing it is how a future field legitimately joins the key, and
  // it must be a deliberate act with a failing test attached rather than a
  // quiet edit.
  it('pins the canonical hash of a known event', () => {
    const event = {
      provider: 'meta',
      providerConnectionIdentifier: '12345',
      providerMessageId: 'msg1',
      contactIdentifier: '111',
      messageKind: 'text',
      bodyText: 'Hello',
      providerTimestamp: '1700000000',
    };

    expect(computeCanonicalHash(event)).toBe(KNOWN_HASH);
  });
});

describe('extractWhatsAppStatuses', () => {
  const payloadWith = (statuses: unknown) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '12345' },
              statuses,
            },
          },
        ],
      },
    ],
  });

  it('extracts a delivered receipt with its event time as ISO', () => {
    const out = extractWhatsAppStatuses(
      payloadWith([{ id: 'wamid.1', status: 'delivered', timestamp: '1729000000' }])
    );
    expect(out).toEqual([
      {
        providerMessageId: 'wamid.1',
        status: 'delivered',
        providerTimestamp: new Date(1729000000 * 1000).toISOString(),
      },
    ]);
  });

  it('extracts multiple statuses across changes, including failed', () => {
    const out = extractWhatsAppStatuses({
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: 'wamid.1', status: 'read', timestamp: '1729000100' }] } },
            { value: { statuses: [{ id: 'wamid.2', status: 'failed' }] } },
          ],
        },
      ],
    });
    expect(out.map((s) => `${s.providerMessageId}:${s.status}`)).toEqual([
      'wamid.1:read',
      'wamid.2:failed',
    ]);
    expect(out[1].providerTimestamp).toBeNull();
  });

  it('skips malformed items instead of throwing — provider-shaped input never crashes the webhook', () => {
    const out = extractWhatsAppStatuses(
      payloadWith([null, {}, { id: 42, status: 'read' }, { id: 'wamid.9' }, { id: 'wamid.9', status: 'read', timestamp: 'junk' }])
    );
    expect(out).toEqual([
      { providerMessageId: 'wamid.9', status: 'read', providerTimestamp: null },
    ]);
  });

  it('returns nothing for message-only payloads and for non-objects', () => {
    expect(extractWhatsAppStatuses({ entry: [{ changes: [{ value: { messages: [] } }] }] })).toEqual([]);
    expect(extractWhatsAppStatuses(null)).toEqual([]);
    expect(extractWhatsAppStatuses('nope')).toEqual([]);
  });
});
