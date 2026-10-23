/**
 * @file outbound-index.ts
 * @description Entrypoint for the outbound WhatsApp delivery worker.
 * Same boot pattern as the other worker entrypoints: env-only
 * configuration, a lazily built composition, a 5s poll loop, and an
 * AbortController-driven shutdown.
 *
 * Two independent things keep this process harmless until the owner
 * enables outbound WhatsApp:
 *   1. The `whatsapp_integration` kill switch (checked inside
 *      OutboundWorker on every batch) is hardcoded `false`; while it
 *      is off, the loop below polls, claims nothing, and sends
 *      nothing.
 *   2. Access tokens are provisioned per connection by the owner.
 *      This entrypoint reads a single deployment token from the
 *      WHATSAPP_ACCESS_TOKEN environment variable (or a *_FILE
 *      variant) — a deliberate single-connection seam for the first
 *      deployment, NOT a per-organization vault. Per-org token
 *      resolution replaces resolveAccessToken when the org secret
 *      vault lands; the worker core does not change.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { OutboundQueueAdapter } from './outbound-queue-adapter';
import { OutboundWorker } from './outbound-worker';
import { WhatsAppSender } from './whatsapp-send';

function readSecretEnv(name: string): string | null {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      const value = readFileSync(filePath, 'utf8').trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`outbound worker: missing required env ${name}`);
  }
  return value;
}

export function createOutboundWorker(client: SupabaseClient): OutboundWorker {
  const deploymentToken = readSecretEnv('WHATSAPP_ACCESS_TOKEN');
  return new OutboundWorker({
    queue: new OutboundQueueAdapter(client),
    sender: new WhatsAppSender(),
    resolveAccessToken: async () => deploymentToken,
  });
}

async function main(): Promise<void> {
  const client = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );
  const worker = createOutboundWorker(client);

  const shutdown = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown.abort());
  }

  while (!shutdown.signal.aborted) {
    try {
      const summary = await worker.processBatch();
      if (summary.gateOpen && summary.claimed > 0) {
        console.log(
          `outbound: claimed=${summary.claimed} sent=${summary.sent} ` +
            `rejected=${summary.rejected} exhausted=${summary.exhausted} ` +
            `deferred=${summary.deferred}`
        );
      }
    } catch (err) {
      console.error(
        `outbound: batch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      error: 'Outbound worker fatal error',
      message: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
