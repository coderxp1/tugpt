import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * @file platform-media-queue-adapter.ts
 * @description PGMQ adapter for the `media_jobs` queue, used by the platform
 * media executor.
 *
 * The same five verbs, the same shapes and the same error classes as
 * `transcription-queue-adapter.ts`, because the runbooks and the operational
 * queries already speak that vocabulary. Every queue operation goes through
 * a service-role RPC (migration 20260927000001); nothing here touches the
 * `pgmq` schema directly.
 *
 * The queue is SHARED: `media_jobs` also carries the ComfyUI lanes' jobs.
 * The claim RPC (`read_media_jobs`) is the one sanctioned claim path — it
 * reconciles `media_generation_jobs.attempts` to PGMQ's `read_ct`, discards
 * messages for jobs that already reached a terminal state, and archives the
 * over-limit delivery internally. The executor therefore pre-checks the job
 * table for platform work before claiming (see platform-media-worker.ts) and
 * releases foreign messages immediately through `setVisibility`, so a
 * platform executor running beside the media worker does not burn other
 * lanes' deliveries.
 */

export interface PlatformMediaQueueMessage {
  msgId: bigint;
  readCt: number;
  payload: Record<string, unknown>;
  enqueuedAt: string;
  vt: string;
}

/**
 * Default lease, matching the RPC's own default and for the same reason: a
 * platform video attempt polls the provider for minutes, and the worker
 * EXTENDS the lease via `setVisibility` while the provider reports
 * queued/running, so 600s is the backstop for a wedged poll loop, not the
 * expected hold time.
 */
export const PLATFORM_MEDIA_DEFAULT_VISIBILITY_SECONDS = 600;

export class PlatformMediaPgmqAdapter {
  constructor(private client: SupabaseClient) {}

  /**
   * Claim work.
   *
   * A message returned here has already been reconciled by the RPC: its job
   * row is in `processing` (or does not exist, which the worker treats as a
   * malformed payload), and terminal/cancelled jobs never reach this point.
   */
  async readJobs(
    limit = 1,
    visibilityTimeoutSeconds = PLATFORM_MEDIA_DEFAULT_VISIBILITY_SECONDS
  ): Promise<PlatformMediaQueueMessage[]> {
    const { data, error } = await this.client.rpc('read_media_jobs', {
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
      p_limit: limit,
    });

    if (error) {
      throw new PlatformMediaQueueReadError(error.code || 'UNKNOWN');
    }

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return [];
    }

    const rows = Array.isArray(data) ? data : [data];
    return rows.map((row: Record<string, unknown>) => ({
      msgId: BigInt(row.msg_id as string | number),
      readCt: row.read_ct as number,
      payload: row.payload as Record<string, unknown>,
      enqueuedAt: row.enqueued_at as string,
      vt: row.vt as string,
    }));
  }

  /** Delete a message that names nothing (malformed payload, missing job row). */
  async deleteJob(msgId: bigint): Promise<boolean> {
    const { data, error } = await this.client.rpc('delete_media_job', {
      p_msg_id: msgId.toString(),
    });

    if (error) {
      throw new PlatformMediaQueueDeleteError(error.code || 'UNKNOWN');
    }

    return data === true;
  }

  /**
   * Shorten or extend a message's lease. Extending is the heartbeat that
   * keeps a long provider poll from being redelivered mid-flight; shortening
   * to a few seconds is how a foreign (non-platform) message is handed back
   * to its own lane's consumer, and how a transient failure backs off.
   */
  async setVisibility(msgId: bigint, visibilityTimeoutSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('set_media_visibility', {
      p_msg_id: msgId.toString(),
      p_visibility_timeout_seconds: visibilityTimeoutSeconds,
    });

    if (error) {
      throw new PlatformMediaQueueVisibilityError(error.code || 'UNKNOWN');
    }

    return data === true;
  }
}

export class PlatformMediaQueueReadError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PlatformMediaQueueReadError';
  }
}

export class PlatformMediaQueueDeleteError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PlatformMediaQueueDeleteError';
  }
}

export class PlatformMediaQueueVisibilityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PlatformMediaQueueVisibilityError';
  }
}
