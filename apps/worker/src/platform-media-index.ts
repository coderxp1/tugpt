/**
 * @file platform-media-index.ts
 * @description Entry point for the platform media executor.
 *
 * A SEPARATE PROCESS, not another loop inside an existing one. The
 * standing rule in docker-compose.yml is one consumer per PGMQ queue; the
 * media worker owns the ComfyUI lanes and this process owns platform
 * video.generate jobs. A platform attempt can legitimately poll a
 * provider for ten minutes, and sharing a process with a latency-bound
 * loop would stall that loop behind one video.
 *
 * STARTS WITH NO PLATFORM CREDENTIALS. Only the Supabase URL and the
 * service-role key are required at boot; the broker key and the egress
 * proxy are process configuration read per job (see
 * platform-media-deps-factory.ts). That is what lets this worker run
 * safely while no organization has the capability entitled, which is its
 * state until the platform checkpoints (CP-6/CP-7) are approved.
 */

import { createAdminSupabaseClient } from '@tugpt/database';
import { buildPlatformMediaDepsFactory } from './platform-media-deps-factory.js';
import { PlatformMediaWorker } from './platform-media-worker.js';
import { PLATFORM_MEDIA_DEFAULT_VISIBILITY_SECONDS } from './platform-media-queue-adapter.js';

const POLL_INTERVAL_MS = parseInt(process.env.PLATFORM_MEDIA_WORKER_POLL_INTERVAL_MS || '5000', 10);
const VISIBILITY_TIMEOUT_SECONDS = parseInt(
  process.env.PLATFORM_MEDIA_WORKER_VISIBILITY_TIMEOUT_SECONDS ||
    String(PLATFORM_MEDIA_DEFAULT_VISIBILITY_SECONDS),
  10
);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as any;

  const worker = new PlatformMediaWorker(client, buildPlatformMediaDepsFactory(client), {
    pollIntervalMs: POLL_INTERVAL_MS,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
  });

  const abortController = new AbortController();
  process.on('SIGINT', () => abortController.abort());
  process.on('SIGTERM', () => abortController.abort());

  await worker.run(abortController.signal);
}

main().catch((err) => {
  console.error(JSON.stringify({
    error: 'Platform media worker fatal error',
    message: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
