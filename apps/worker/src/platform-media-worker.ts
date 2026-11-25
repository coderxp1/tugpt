import type { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '@tugpt/observability';
import { PlatformMediaPgmqAdapter, type PlatformMediaQueueMessage } from './platform-media-queue-adapter.js';
import {
  createPlatformMediaJobsPort, isPlatformMediaJob, MEDIA_GENERATION_FLAG,
  type MediaJobRow, type PlatformMediaJobsPort,
} from './platform-media-jobs.js';
import { runPlatformVideoJob, type PlatformMediaExecutorDeps } from './platform-media-executor.js';

/**
 * @file platform-media-worker.ts
 * @description The platform media executor process: claims platform
 * video.generate jobs from the shared `media_jobs` queue and drives them
 * to a terminal state through the platform MCP track.
 *
 * ===========================================================================
 * THE ONE THING THIS WORKER IS ORGANISED AROUND
 * ===========================================================================
 *
 * **The provider bills on submission.** Every structural decision follows:
 *
 *   * The executor NEVER resubmits a job that already carries an external
 *     id — it resumes polling the submission that was already paid for.
 *     The id is persisted before any polling (inside the executor), so a
 *     crash, a SIGKILL or a lease expiry costs a resume, never a second
 *     bill. This mirrors the transcription worker's discipline for Gladia.
 *
 *   * The audit hook runs BEFORE the billable submit and is fail-closed:
 *     if the audit checkpoint cannot be written, the provider is never
 *     called.
 *
 *   * There is NO fallback renderer. A platform failure archives the job
 *     with a typed code; nothing here can produce a ComfyUI/WAN render.
 *
 * ===========================================================================
 * SHARING THE QUEUE
 * ===========================================================================
 *
 * `media_jobs` also carries the ComfyUI lanes' jobs, whose consumer is the
 * media worker. The claim RPC reconciles delivery counts, so claiming a
 * foreign job is not free — it spends one of that job's deliveries. This
 * worker therefore pre-checks the job table for claimable platform work
 * before it touches the queue at all, claims one message at a time, and
 * releases a foreign message immediately (short visibility) without
 * executing or failing it. The standing deployment rule still applies —
 * one consumer per queue per deployment; running this executor beside the
 * media worker is safe but the pre-check exists precisely because the
 * claim itself has a cost.
 *
 * ===========================================================================
 * EXECUTION-TIME GATES
 * ===========================================================================
 *
 * Enqueue gated the job once; this worker re-checks at execution time,
 * because an operator can turn things off while a job waits:
 *
 *   * `media_generation` flag off for the org -> the job is archived with
 *     ENTITLEMENT_DISABLED. Executing anyway would spend against a gate
 *     the operator deliberately closed; releasing it would spin forever.
 *   * Flag state unverifiable (RPC error) -> the message is released with
 *     a backoff and retried on redelivery. Fail-closed means no billable
 *     call happens, not that the job is destroyed by a transient error.
 *   * Binding, endpoint, snapshot and token are re-resolved per job and
 *     per call inside the executor/resolver — never trusted from
 *     submit-time state.
 *
 * ===========================================================================
 * CONTENT PRIVACY
 * ===========================================================================
 *
 * Never logged: the prompt, the provider's URLs, the access token, the
 * broker key. Logged: job id, organization id, capability, outcome,
 * typed error codes, attempt number.
 */

const logger = new Logger({ service: 'platform-media-worker' });

/** Thrown by the deps factory when the platform track is not configured in this process. */
export class PlatformMediaNotConfiguredError extends Error {
  readonly code = 'PLATFORM_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'PlatformMediaNotConfiguredError';
  }
}

/**
 * Builds the executor's dependencies for one job. A factory rather than
 * injected instances, and called PER JOB, because the broker key and the
 * egress configuration are process configuration that an operator may fix
 * without restarting — and because a cached broker client would keep a
 * rotated key alive until the next restart. Throwing
 * PlatformMediaNotConfiguredError is how an unconfigured track surfaces.
 */
export type PlatformMediaDepsFactory = () => Promise<PlatformMediaExecutorDeps>;

export interface PlatformMediaWorkerConfig {
  pollIntervalMs: number;
  visibilityTimeoutSeconds: number;
  /** Lease given back when a claimed message turns out to belong to another lane. */
  foreignReleaseSeconds?: number;
  /** Lease given back when a transient failure should be retried on redelivery. */
  transientBackoffSeconds?: number;
  /** Lease-extension cadence while a job executes; defaults to a third of the lease. */
  heartbeatIntervalMs?: number;
}

type FlagState = 'on' | 'off' | 'unknown';

export class PlatformMediaWorker {
  private queue: PlatformMediaPgmqAdapter;
  private jobs: PlatformMediaJobsPort;
  private pollIntervalMs: number;
  private visibilityTimeoutSeconds: number;
  private foreignReleaseSeconds: number;
  private transientBackoffSeconds: number;
  private heartbeatIntervalMs: number;

  constructor(
    private client: SupabaseClient,
    private buildDeps: PlatformMediaDepsFactory,
    config: PlatformMediaWorkerConfig,
  ) {
    this.queue = new PlatformMediaPgmqAdapter(client);
    this.jobs = createPlatformMediaJobsPort(client);
    this.pollIntervalMs = config.pollIntervalMs;
    this.visibilityTimeoutSeconds = config.visibilityTimeoutSeconds;
    this.foreignReleaseSeconds = config.foreignReleaseSeconds
      ?? Math.max(1, Math.ceil(config.pollIntervalMs / 1000));
    this.transientBackoffSeconds = config.transientBackoffSeconds ?? 30;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs
      ?? Math.max(1000, Math.floor((config.visibilityTimeoutSeconds * 1000) / 3));
  }

  async run(signal: AbortSignal): Promise<void> {
    logger.info('Platform media worker started', {});

    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error('Platform media worker poll error', err as Error, {});
      }
      await this.sleep(this.pollIntervalMs, signal);
    }

    logger.info('Platform media worker shutting down', {});
  }

  /**
   * One claim cycle. The table pre-check comes first: with no platform
   * work waiting, the shared queue is never touched, so foreign jobs keep
   * every one of their deliveries.
   */
  async pollOnce(): Promise<void> {
    if (!(await this.jobs.hasClaimablePlatformJob())) return;
    const messages = await this.queue.readJobs(1, this.visibilityTimeoutSeconds);
    for (const message of messages) {
      await this.processMessage(message);
    }
  }

  async processMessage(message: PlatformMediaQueueMessage): Promise<void> {
    const { msgId, readCt, payload } = message;
    const mediaJobId = typeof payload.mediaJobId === 'string' ? payload.mediaJobId : undefined;

    // A message with no job id names nothing. It cannot be archived — the
    // archive RPC dead-letters a JOB, and there is none — and leaving it
    // queued means redelivering it forever. Deleting it loses a pointer to
    // nothing, which is the least bad of the three. (Same reasoning as the
    // transcription and draft paths.)
    if (!mediaJobId) {
      logger.error('Malformed queue payload: no mediaJobId', undefined, {
        queueMessageId: msgId.toString(),
      });
      await this.queue.deleteJob(msgId);
      return;
    }

    let job: MediaJobRow | null;
    try {
      job = await this.jobs.getJob(mediaJobId);
    } catch (err) {
      logger.error('Platform media job load failed; backing off', err as Error, { mediaJobId });
      await this.release(msgId, this.transientBackoffSeconds);
      return;
    }
    if (!job) {
      logger.error('Media job not found', undefined, { mediaJobId });
      await this.queue.deleteJob(msgId);
      return;
    }

    // Not ours: another lane's job that happened to be at the head of the
    // shared queue while platform work waited behind it. Hand it back
    // untouched — no execution, no failure, no state change beyond the
    // claim RPC's own reconciliation.
    if (!isPlatformMediaJob(job)) {
      await this.release(msgId, this.foreignReleaseSeconds);
      return;
    }

    logger.info('Processing platform media job', {
      mediaJobId: job.id, organizationId: job.organizationId, attempt: readCt,
      resumed: job.promptId != null,
    });

    // Execution-time entitlement gate (see header). The enqueue gate made
    // its decision when the job was submitted; the operator's current
    // decision is the one that spends money, so it is re-read here.
    const flag = await this.checkFlag(job.organizationId);
    if (flag === 'off') {
      logger.info('media_generation disabled at execution time; archiving job', {
        mediaJobId: job.id, organizationId: job.organizationId, errorCode: 'ENTITLEMENT_DISABLED',
      });
      await this.jobs.archiveFailed(Number(msgId), job.id, 'ENTITLEMENT_DISABLED',
        'the media_generation flag is off for the organization at execution time');
      return;
    }
    if (flag === 'unknown') {
      logger.error('media_generation flag unverifiable; backing off without executing', undefined, {
        mediaJobId: job.id, organizationId: job.organizationId,
      });
      await this.release(msgId, this.transientBackoffSeconds);
      return;
    }

    let deps: PlatformMediaExecutorDeps;
    try {
      deps = await this.buildDeps();
    } catch (err) {
      if (err instanceof PlatformMediaNotConfiguredError) {
        // An operator misconfiguration, archived immediately rather than
        // retried, with the code naming the cause — retrying reaches the
        // same answer on every delivery. The honest cost, as with the
        // transcription worker's credential case: jobs queued while the
        // track is unconfigured dead-letter, and the log line below is
        // written to be the whole diagnosis.
        logger.error(
          'Platform track not configured; archiving job. Set TUGPT_BROKER_URL, TUGPT_BROKER_PLATFORM_KEY and CONNECT_EGRESS_PROXY for this process.',
          err,
          { mediaJobId: job.id, organizationId: job.organizationId, errorCode: err.code },
        );
        await this.jobs.archiveFailed(Number(msgId), job.id, err.code, err.message);
        return;
      }
      logger.error('Platform media deps build failed; backing off', err as Error, { mediaJobId: job.id });
      await this.release(msgId, this.transientBackoffSeconds);
      return;
    }

    // Lease heartbeat: a platform attempt legitimately polls the provider
    // for longer than one lease. The claim RPC's 600s backstop is for a
    // wedged loop, not the expected hold time — so the lease is extended
    // while the attempt runs, exactly as the media worker does for
    // ComfyUI's queued/running reports.
    const heartbeat = setInterval(() => {
      void this.queue.setVisibility(msgId, this.visibilityTimeoutSeconds)
        .catch((err) => logger.error('Lease extension failed', err as Error, { mediaJobId: job.id }));
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      const result = await runPlatformVideoJob(deps, job);
      if (result.outcome === 'completed') {
        logger.info('Platform media job completed', {
          mediaJobId: job.id, organizationId: job.organizationId, resultPath: result.resultPath, attempt: readCt,
        });
      } else {
        logger.info('Platform media job failed', {
          mediaJobId: job.id, organizationId: job.organizationId, errorCode: result.errorCode, attempt: readCt,
        });
      }
      // Terminal states settle the queue message inside the complete /
      // archive RPCs — there is nothing left to delete or release here.
    } catch (err) {
      // The executor drives every EXPECTED failure to a typed archive
      // itself; an exception escaping it is a defect or a dead database.
      // The job was not driven terminal, so hand the message back with a
      // backoff: redelivery resumes from the recorded external id if the
      // submit already happened, and the claim RPC exhausts-archive on
      // the fourth delivery if the defect persists.
      logger.error('Platform media executor error; backing off for resume', err as Error, {
        mediaJobId: job.id, organizationId: job.organizationId, attempt: readCt,
      });
      await this.release(msgId, this.transientBackoffSeconds);
    } finally {
      clearInterval(heartbeat);
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private async checkFlag(organizationId: string): Promise<FlagState> {
    const { data, error } = await this.client.rpc('is_feature_enabled', {
      p_organization_id: organizationId,
      p_flag_key: MEDIA_GENERATION_FLAG,
    });
    if (error) return 'unknown';
    return data === true ? 'on' : 'off';
  }

  private async release(msgId: bigint, seconds: number): Promise<void> {
    await this.queue.setVisibility(msgId, seconds).catch((err) => {
      logger.error('Failed to release media queue message', err as Error, {
        queueMessageId: msgId.toString(),
      });
    });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
