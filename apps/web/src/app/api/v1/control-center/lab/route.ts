// Control Center lab runner. POST { test, input } runs one lab from
// lib/control-center/labs.ts and returns its real result. Labs run
// in-process against fixtures; nothing here sends a message, calls a
// provider, writes to a database, or spends money. Blocked labs return
// mode 'blocked' with the reason instead of a fabricated success.

import { NextResponse } from 'next/server';
import {
  labAppointments,
  labBlocked,
  labDeliveryReceipts,
  labFaqRetrieval,
  labGroundedPrompt,
  labWhatsAppInbound,
} from '@/lib/control-center/labs';

const RUNNABLE = [
  'faq-retrieval',
  'grounded-prompt',
  'whatsapp-inbound',
  'delivery-receipts',
  'appointments',
] as const;

export async function POST(request: Request) {
  let body: { test?: unknown; input?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'Request body must be JSON.' } },
      { status: 400 },
    );
  }
  const test = body.test;
  const input = body.input ?? {};
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
        return NextResponse.json(
          labBlocked(
            'voice-transcription',
            'The transcription pipeline needs a Gladia key (vault-provisioned) and a database. Neither is configured here. Pipeline stages and the transcript-to-draft rule are proven by worker suites and pgTAP.',
          ),
        );
      case 'media-generation':
        return NextResponse.json(
          labBlocked(
            'media-generation',
            'Generation needs the GPU worker and media_generation enabled for an org. Both are off here: no GPU host is connected to this environment and the flag stays OFF for prod orgs until launch limits are approved.',
          ),
        );
      case 'usage':
        return NextResponse.json(
          labBlocked(
            'usage',
            'Usage totals come from the org_usage_summary RPC, which needs a database session. No database is configured in this environment; the /dashboard/analytics page shows real totals once Supabase is configured.',
          ),
        );
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
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: 'LAB_FAILED',
          message: err instanceof Error ? err.message : 'Lab execution failed.',
        },
      },
      { status: 500 },
    );
  }
}
