// TuGPT Product Control Center — lab runners.
//
// Every runnable lab executes REAL product code in-process, against
// fixtures the user supplies or the defaults below. Nothing here sends
// a message, calls a provider, touches a database, or spends money.
// Labs that need a live integration return { mode: 'blocked' } with the
// reason, instead of a fabricated success.

import { selectKnowledgeEntries } from '@tugpt/database';
import {
  AvailabilityService,
  InMemoryAppointmentStore,
  MockBehaviour,
  MockCalendarAvailabilityProvider,
} from '@tugpt/appointments';
import {
  extractWhatsAppStatuses,
  normalizeWhatsAppEnvelope,
} from '@/lib/whatsapp-normalizer';
import { toDeliveryView } from '@/lib/draft-api/delivery-status';
import { KILL_SWITCHES } from '@tugpt/feature-flags';

export type LabMode = 'real-in-process' | 'simulated-provider' | 'blocked';

export interface LabResult {
  test: string;
  mode: LabMode;
  /** Human-readable summary of what actually ran. */
  summary: string;
  /** Structured output for the UI to render. JSON-safe. */
  output: unknown;
}

export interface FaqEntryInput {
  question: string;
  answer: string;
  enabled?: boolean;
}

const DEFAULT_FAQ: FaqEntryInput[] = [
  {
    question: '¿Cuál es el horario de atención?',
    answer: 'Atendemos de lunes a viernes de 9:00 a 18:00.',
  },
  {
    question: '¿Hacen envíos a domicilio?',
    answer: 'Sí, enviamos a toda la ciudad en 24 horas.',
  },
  {
    question: '¿Cuál es el precio del servicio básico?',
    answer: 'El servicio básico cuesta 29,90 €.',
  },
];

export function labFaqRetrieval(input: {
  entries?: FaqEntryInput[];
  question?: string;
}): LabResult {
  const entries = (input.entries ?? DEFAULT_FAQ).map((e) => ({
    question: e.question,
    answer: e.answer,
    enabled: e.enabled ?? true,
  }));
  const question = input.question ?? '¿Cuál es el horario?';
  const selected = selectKnowledgeEntries(entries, question);
  return {
    test: 'faq-retrieval',
    mode: 'real-in-process',
    summary: `Ran the production shared selection function (packages/database/src/knowledge-selection.ts) over ${entries.length} entries for "${question}". ${selected.length} entr${selected.length === 1 ? 'y' : 'ies'} selected — the same function the draft worker and the FAQ preview call.`,
    output: { question, selected },
  };
}

export function labGroundedPrompt(input: {
  entries?: FaqEntryInput[];
  question?: string;
}): LabResult {
  const retrieval = labFaqRetrieval(input);
  const selected = retrieval.output as {
    selected: { question: string; answer: string }[];
  };
  // The worker inserts the selected entries into the draft prompt under
  // localized subordination framing, BEFORE the unremovable guardrails
  // (PR #14). This lab renders that block exactly as the worker formats
  // it from the same selection — the prompt assembly itself runs in the
  // worker, covered by its own suites, not here.
  const block =
    selected.selected.length === 0
      ? '(no entries matched — the worker sends the prompt byte-identical to pre-FAQ behavior)'
      : selected.selected
          .map((e) => `Pregunta: ${e.question}\nRespuesta: ${e.answer}`)
          .join('\n---\n');
  return {
    test: 'grounded-prompt',
    mode: 'real-in-process',
    summary: `Selection ran through the production function; the block below is the worker's grounding format for ${selected.selected.length} matched entries. Prompt assembly with guardrails runs in the draft worker (worker suites), not in this lab.`,
    output: { question: (retrieval.output as { question: string }).question, block },
  };
}

const DEFAULT_WEBHOOK_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: 'lab-phone-number-id' },
            messages: [
              {
                from: '34600000000',
                id: 'wamid.test123',
                timestamp: '1761234567',
                type: 'text',
                text: { body: 'Hola, ¿cuál es el horario?' },
              },
            ],
          },
        },
      ],
    },
  ],
};

export function labWhatsAppInbound(input: { payload?: unknown }): LabResult {
  const payload = input.payload ?? DEFAULT_WEBHOOK_PAYLOAD;
  const events = normalizeWhatsAppEnvelope(payload);
  return {
    test: 'whatsapp-inbound',
    mode: 'real-in-process',
    summary: `Ran the production webhook normalizer (lib/whatsapp-normalizer.ts) over a synthetic Meta payload. ${events.length} message event(s) extracted; no message was sent, stored, or delivered — normalization only.`,
    output: { events },
  };
}

export function labDeliveryReceipts(input: {
  currentStatus?: string;
  receipt?: string;
}): LabResult {
  const statuses = extractWhatsAppStatuses({
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: 'wamid.test123',
                  status: input.receipt ?? 'read',
                  timestamp: '1761234600',
                },
              ],
            },
          },
        ],
      },
    ],
  });
  // The delivery view maps a stored row to its display state; feed it a
  // row in the requested prior state plus the receipt to show the
  // monotonic transition the RPC enforces (read implies delivered,
  // nothing moves backwards — proven by pgTAP, illustrated here).
  const prior = (input.currentStatus ?? 'sent') as string;
  const view = toDeliveryView({
    id: 'lab-delivery-1',
    draft_id: 'lab-draft-1',
    status: prior,
    provider_message_id: 'wamid.test123',
    attempts: 1,
    error_code: null,
    updated_at: '2026-10-23T10:00:00Z',
    delivered_at:
      input.receipt === 'delivered' || input.receipt === 'read'
        ? '2026-10-23T10:00:00Z'
        : null,
    read_at: input.receipt === 'read' ? '2026-10-23T10:01:00Z' : null,
  });
  return {
    test: 'delivery-receipts',
    mode: 'real-in-process',
    summary: `Parsed a synthetic status callback with the production extractor (${statuses.length} status(es)) and mapped a ${prior} row through the production display function. Monotonicity itself is enforced by the receipt RPC and proven by pgTAP, not by this illustration.`,
    output: { statuses, view },
  };
}

export async function labAppointments(input: {
  windowStart?: string;
  windowEnd?: string;
  durationMinutes?: number;
}): Promise<LabResult> {
  const provider = new MockCalendarAvailabilityProvider({
    behaviour: MockBehaviour.AVAILABLE,
  });
  const service = new AvailabilityService(provider);
  const result = await service.findAvailability({
    window: {
      start: input.windowStart ?? '2026-10-27T09:00:00.000Z',
      end: input.windowEnd ?? '2026-10-27T17:00:00.000Z',
    },
    durationMinutes: input.durationMinutes ?? 30,
    timeZone: 'Europe/Madrid',
    calendarId: 'lab-calendar',
    limit: 5,
  });
  // The store path is the real persistence interface, in-memory here:
  // record a request, then read it back — creation, validation, and
  // retrieval through production code, with no Google involved.
  const store = new InMemoryAppointmentStore();
  const request = await store.recordRequest({
    organizationId: 'lab-org',
    idempotencyKey: 'lab-1',
    windowStart: input.windowStart ?? '2026-10-27T09:00:00.000Z',
    windowEnd: input.windowEnd ?? '2026-10-27T17:00:00.000Z',
    durationMinutes: input.durationMinutes ?? 30,
    timeZone: 'Europe/Madrid',
  });
  const readBack = await store.getRequest(request.id);
  return {
    test: 'appointments',
    mode: 'simulated-provider',
    summary: `Real AvailabilityService + real InMemoryAppointmentStore ran against the package's MockCalendarAvailabilityProvider (SIMULATED calendar — Google free/busy is NOT involved; credentials are not used). Slots: ${result.ok ? result.slots.length : 0}; store round-trip: ${readBack ? 'request retrieved' : 'FAILED'}. The DB CHECK refusing CONFIRMED writes is proven by pgTAP, not here.`,
    output: {
      availability: result,
      storedRequestId: request.id,
      readBackFound: readBack !== null,
    },
  };
}

export function labBlocked(test: string, reason: string): LabResult {
  return {
    test,
    mode: 'blocked',
    summary: `Not runnable here: ${reason}`,
    output: { blockedReason: reason },
  };
}

export function labOverview(): {
  killSwitch: boolean;
  envPresence: Record<string, boolean>;
} {
  return {
    killSwitch: (KILL_SWITCHES as Record<string, unknown>).whatsapp_integration === true,
    envPresence: {
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      WHATSAPP_APP_SECRET: Boolean(process.env.WHATSAPP_APP_SECRET),
      WHATSAPP_VERIFY_TOKEN: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
      WHATSAPP_ACCESS_TOKEN: Boolean(
        process.env.WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_ACCESS_TOKEN_FILE,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Blocked labs. Each reason is composed from what is actually present in this
// process's environment, so the same text cannot be wrong on a different
// machine. "Gladia" and "GPU" name the real dependencies; the database clause
// changes with NEXT_PUBLIC_SUPABASE_URL.

function databaseClause(): string {
  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return configured
    ? 'A Supabase project is configured here, but the Control Center deliberately runs without a tenant session, so it cannot read or write tenant rows.'
    : 'No Supabase project is configured here (NEXT_PUBLIC_SUPABASE_URL unset).';
}

export function labVoiceTranscriptionBlocked(): LabResult {
  return labBlocked(
    'voice-transcription',
    `The transcription pipeline needs a vault-provisioned Gladia key and a database session. This lab does not access the credential vault or invoke Gladia. ${databaseClause()} Pipeline stages and the transcript-to-draft rule are proven by the worker suites and pgTAP, not by a live run here.`,
  );
}

export function labMediaGenerationBlocked(): LabResult {
  return labBlocked(
    'media-generation',
    'Generation needs the GPU worker and media_generation enabled for an organization. This lab does not enqueue GPU work or inspect tenant feature flags. Use the authenticated /dashboard/media workflow only after provisioning and launch approval.',
  );
}

export function labUsageBlocked(): LabResult {
  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return labBlocked(
    'usage',
    configured
      ? 'Usage totals come from the org_usage_summary RPC, which runs as the signed-in user under RLS. The Control Center deliberately has no tenant session, so it cannot call it; sign in and open /dashboard/analytics for the real totals.'
      : 'Usage totals come from the org_usage_summary RPC, which needs a database session. No Supabase project is configured here (NEXT_PUBLIC_SUPABASE_URL unset); once one is, /dashboard/analytics shows the real totals.',
  );
}
