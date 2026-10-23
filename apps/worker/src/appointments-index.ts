/**
 * @file appointments-index.ts
 * @description Dedicated entry point for the appointments availability
 * process.
 *
 * This is a SEPARATE process from the WhatsApp worker (index.ts), the draft
 * worker (draft-index.ts) and the transcription worker
 * (transcription-index.ts), per the same amendment that keeps those apart:
 * one process per capability, so a fault or a deploy in one cannot take
 * the others with it.
 *
 * ===========================================================================
 * THE TRANSPORT IS NDJSON OVER STDIO — DELIBERATELY
 * ===========================================================================
 *
 * There is no queue and no HTTP surface for appointment requests in this
 * codebase yet, and this file does not invent one: a migration for a queue
 * nobody produces into, or an HTTP server with an auth model nobody
 * reviewed, would both be larger claims than this milestone makes. What
 * exists and is real is the composition (appointments-deps-factory.ts) and
 * the boundary in front of it (appointments-handler.ts).
 *
 * So the process speaks the simplest honest protocol: one JSON request per
 * line on stdin, one JSON result per line on stdout. A supervisor, a test
 * harness, or a future transport shim can drive it today; when a queue or
 * an HTTP route lands, it calls the same handler and this file shrinks to
 * boot code.
 *
 * ===========================================================================
 * BOOT AND FAILURE BEHAVIOUR
 * ===========================================================================
 *
 * Boot needs only infrastructure credentials (Supabase URL + service role
 * key), like the other workers. Everything else — the feature flag, the
 * organization's Google credential, the OAuth client — is resolved lazily
 * per request and fails closed there (see the factory and handler
 * headers), so this process starts and answers NOT_CONFIGURED while
 * google_calendar_freebusy is off everywhere, which is its state on every
 * organization today.
 *
 * One malformed line never kills the process: it is answered
 * INVALID_REQUEST and the loop continues. SIGINT/SIGTERM close stdin and
 * exit cleanly.
 *
 * Package scripts:
 *   dev:appointments   → tsx src/appointments-index.ts
 *   start:appointments → node dist/appointments-index.js
 */

import { createInterface } from 'node:readline';
import { createAdminSupabaseClient } from '@tugpt/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAppointmentsDeps } from './appointments-deps-factory.js';
import { createAppointmentRequestHandler } from './appointments-handler.js';

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(JSON.stringify({
      error: 'Missing required environment variables',
      required: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    }));
    process.exit(1);
  }

  const client = createAdminSupabaseClient(
    supabaseUrl,
    serviceRoleKey
  ) as unknown as SupabaseClient;

  const handle = createAppointmentRequestHandler(buildAppointmentsDeps(client));

  const lines = createInterface({ input: process.stdin, terminal: false });

  const shutdown = (): void => {
    lines.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.error(JSON.stringify({
    event: 'appointments_worker_started',
    transport: 'ndjson-stdio',
  }));

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          code: 'INVALID_REQUEST',
          detail: 'line is not valid JSON',
        }) + '\n'
      );
      continue;
    }

    const result = await handle(payload);
    process.stdout.write(JSON.stringify(result) + '\n');
  }

  console.error(JSON.stringify({ event: 'appointments_worker_stopped' }));
}

main().catch((err) => {
  console.error(JSON.stringify({
    error: 'Appointments worker fatal error',
    message: (err as Error).message,
  }));
  process.exit(1);
});
