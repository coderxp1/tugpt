/**
 * @file platform-media-deps-factory.ts
 * @description Builds the platform media executor's dependencies, per job.
 *
 * Everything here is process configuration read at job time, never at
 * boot — the transcription worker's rule, for the same reason: the worker
 * must be safe to run with the track unconfigured (it simply never claims
 * platform work it cannot execute... and if a job IS claimed while the
 * track is unconfigured, the factory's typed refusal archives it loudly
 * instead of guessing).
 *
 * Credentials resolve ONLY through the credential broker's platform
 * namespace: the broker client is constructed with caller 'platform' and
 * the key from TUGPT_BROKER_PLATFORM_KEY, exactly like the web platform
 * broker client. This process never holds a provider credential and never
 * sees a platform_connection_credentials row.
 *
 * The audit hook: the schema has no platform execution audit table (the
 * persistent, dual-attribution audit record is B8's verified-metering
 * scope, and adding a table is a migration this change does not make).
 * What the hook does here is the fail-closed checkpoint the bridge
 * contract requires, against the durable state that exists today:
 *
 *   - the event is written to the process's structured audit log, and
 *   - on the submit phase, the job row is re-read and must still be in
 *     `processing` — a job cancelled or settled between claim and submit
 *     aborts here, BEFORE the billable call, with the bridge's
 *     AUDIT_UNAVAILABLE code.
 *
 * If either step throws, the provider is never called.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '@tugpt/observability';
import { BrokerClient } from '@tugpt/credential-broker/dist/client.js';
import { createPlatformMediaRepository } from './platform-media-repo.js';
import { createPlatformCaller } from './platform-media-resolver.js';
import { createPlatformMediaJobsPort, MEDIA_BUCKET } from './platform-media-jobs.js';
import { createEgressBinaryFetch, createEgressMcpFetch, parseEgressProxy, EGRESS_PROXY_ENV } from './platform-media-egress.js';
import { PlatformMediaNotConfiguredError, type PlatformMediaDepsFactory } from './platform-media-worker.js';
import type { PlatformMediaExecutorDeps } from './platform-media-executor.js';

const auditLogger = new Logger({ service: 'platform-media-audit' });

/**
 * Broker client for the platform namespace (ADR-022 D2): caller
 * 'platform', key from TUGPT_BROKER_PLATFORM_KEY (hex, >= 32 bytes),
 * broker at TUGPT_BROKER_URL. Null when unconfigured so the factory can
 * refuse with a typed code instead of guessing.
 */
export function platformBrokerClient(env: NodeJS.ProcessEnv = process.env): BrokerClient | null {
  const baseUrl = env.TUGPT_BROKER_URL;
  const key = env.TUGPT_BROKER_PLATFORM_KEY?.trim();
  if (!baseUrl || !key) return null;
  try {
    return new BrokerClient({ baseUrl, caller: 'platform', key: Buffer.from(key, 'hex') });
  } catch {
    return null;
  }
}

export function buildPlatformMediaDepsFactory(
  client: SupabaseClient,
  env: NodeJS.ProcessEnv = process.env,
): PlatformMediaDepsFactory {
  const repo = createPlatformMediaRepository(client);
  const jobs = createPlatformMediaJobsPort(client);

  return async (): Promise<PlatformMediaExecutorDeps> => {
    const broker = platformBrokerClient(env);
    if (!broker) {
      throw new PlatformMediaNotConfiguredError(
        'the platform broker client is not configured (TUGPT_BROKER_URL / TUGPT_BROKER_PLATFORM_KEY)',
      );
    }
    const proxyUrl = env[EGRESS_PROXY_ENV];
    if (!parseEgressProxy(proxyUrl)) {
      throw new PlatformMediaNotConfiguredError(
        `the egress proxy is not configured (${EGRESS_PROXY_ENV})`,
      );
    }

    const egressFetch = createEgressMcpFetch({ proxyUrl });
    const fetchBinary = createEgressBinaryFetch({ proxyUrl });
    const caller = createPlatformCaller({ repo, broker, egressFetch });

    return {
      repo,
      caller,
      jobs,
      fetchBinary,
      store: async (path, bytes, contentType) => {
        // The media bucket has no customer-facing storage policies by
        // design; the service-role client writes the tenant key directly.
        // upsert: a redelivered attempt that already stored the object
        // (crash between store and complete) must be able to store the
        // same job-scoped key again — the content is the same job's MP4.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = (client as any).storage;
        const { error } = await storage.from(MEDIA_BUCKET).upload(path, bytes, {
          contentType, upsert: true,
        });
        if (error) throw new Error(`media storage upload failed: ${error.message ?? 'unknown error'}`);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      audit: async (event) => {
        auditLogger.info('Platform media execution audit', event);
        if (event.phase === 'submit') {
          const job = await jobs.getJob(String(event.jobId));
          if (!job || job.status !== 'processing') {
            throw new Error('the job is no longer in processing; refusing the billable submit');
          }
        }
      },
    };
  };
}
