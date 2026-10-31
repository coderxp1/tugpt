// Control Center lab runner. POST { test, input } runs one lab from
// lib/control-center/labs.ts and returns its real result. Labs run
// in-process against fixtures; nothing here sends a message, calls a
// provider, writes to a database, or spends money. Blocked labs return
// mode 'blocked' with the reason instead of a fabricated success.

import { NextResponse } from 'next/server';
import {
  labAppointments,
  labDeliveryReceipts,
  labFaqRetrieval,
  labGroundedPrompt,
  labMediaGenerationBlocked,
  labUsageBlocked,
  labVoiceTranscriptionBlocked,
  labWhatsAppInbound,
} from '@/lib/control-center/labs';

const RUNNABLE = [
  'faq-retrieval',
  'grounded-prompt',
  'whatsapp-inbound',
  'delivery-receipts',
  'appointments',
] as const;

/** Largest lab request body accepted (bytes). Labs run pure functions
 *  over small fixtures; a larger body is either a mistake or a
 *  denial-of-service attempt, and there is no legitimate lab input
 *  anywhere near this size. */
const MAX_BODY_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape-checks lab input BEFORE any production function sees it, so a
 *  malformed request gets a 400 instead of a 500 (and an internal error
 *  message). Returns an error string, or null when the input is valid. */
function validateInput(test: string, input: unknown): string | null {
  if (!isRecord(input)) return 'input must be a JSON object';
  switch (test) {
    case 'faq-retrieval':
    case 'grounded-prompt': {
      if (input.entries !== undefined) {
        if (!Array.isArray(input.entries) || input.entries.length > 50) {
          return 'entries must be an array of at most 50 FAQ entries';
        }
        for (const entry of input.entries) {
          if (
            !isRecord(entry) ||
            typeof entry.question !== 'string' ||
            typeof entry.answer !== 'string' ||
            entry.question.length > 4000 ||
            entry.answer.length > 4000 ||
            (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
          ) {
            return 'each entry needs a question and answer (max 4000 chars each) and an optional boolean enabled flag';
          }
        }
      }
      if (input.question !== undefined) {
        if (typeof input.question !== 'string' || input.question.length > 2000) {
          return 'question must be a string of at most 2000 chars';
        }
      }
      return null;
    }
    case 'whatsapp-inbound': {
      if (input.payload !== undefined && !isRecord(input.payload)) {
        return 'payload must be a JSON object';
      }
      return null;
    }
    case 'delivery-receipts': {
      if (
        input.currentStatus !== undefined &&
        !['queued', 'sending', 'sent'].includes(String(input.currentStatus))
      ) {
        return 'currentStatus must be queued, sending, or sent';
      }
      if (
        input.receipt !== undefined &&
        !['delivered', 'read'].includes(String(input.receipt))
      ) {
        return 'receipt must be delivered or read';
      }
      return null;
    }
    case 'appointments': {
      if (input.durationMinutes !== undefined) {
        const d = input.durationMinutes;
        if (
          typeof d !== 'number' ||
          !Number.isInteger(d) ||
          d < 5 ||
          d > 480
        ) {
          return 'durationMinutes must be a whole number between 5 and 480';
        }
      }
      for (const key of ['windowStart', 'windowEnd']) {
        if (input[key] !== undefined) {
          if (
            typeof input[key] !== 'string' ||
            Number.isNaN(Date.parse(input[key] as string))
          ) {
            return `${key} must be an ISO date string`;
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export async function POST(request: Request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: 'BODY_TOO_LARGE', message: 'Lab request body exceeds 64 KB.' } },
      { status: 413 },
    );
  }
  let body: { test?: unknown; input?: Record<string, unknown> };
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing JSON');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return NextResponse.json(
          { error: { code: 'BODY_TOO_LARGE', message: 'Lab request body exceeds 64 KB.' } },
          { status: 413 },
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) throw new Error('Expected JSON object');
    body = parsed;
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'Request body must be JSON.' } },
      { status: 400 },
    );
  }
  const test = body.test;
  const input = body.input ?? {};
  if (typeof test !== 'string') {
    return NextResponse.json(
      { error: { code: 'UNKNOWN_TEST', message: 'test must be a string naming a lab.' } },
      { status: 400 },
    );
  }
  const inputError = validateInput(test, input);
  if (inputError !== null) {
    return NextResponse.json(
      { error: { code: 'INVALID_INPUT', message: inputError } },
      { status: 400 },
    );
  }
  try {
    switch (test) {
      case 'faq-retrieval':
        return NextResponse.json(labFaqRetrieval(input as never));
      case 'grounded-prompt':
        return NextResponse.json(labGroundedPrompt(input as never));
      case 'whatsapp-inbound':
        return NextResponse.json(labWhatsAppInbound(input as never));
      case 'delivery-receipts':
        return NextResponse.json(labDeliveryReceipts(input as never));
      case 'appointments':
        return NextResponse.json(await labAppointments(input as never));
      case 'voice-transcription':
        return NextResponse.json(labVoiceTranscriptionBlocked());
      case 'media-generation':
        return NextResponse.json(labMediaGenerationBlocked());
      case 'usage':
        return NextResponse.json(labUsageBlocked());
      default:
        return NextResponse.json(
          {
            error: {
              code: 'UNKNOWN_TEST',
              message: `Unknown lab test. Runnable: ${RUNNABLE.join(', ')}. Blocked (honest, not runnable): voice-transcription, media-generation, usage.`,
            },
          },
          { status: 400 },
        );
    }
  } catch {
    // Deliberately generic: a lab failure must not leak internal error
    // text to the caller. The failure is still visible
    // in server logs via the platform's own logging.
    return NextResponse.json(
      {
        error: {
          code: 'LAB_FAILED',
          message: 'Lab execution failed.',
        },
      },
      { status: 500 },
    );
  }
}
