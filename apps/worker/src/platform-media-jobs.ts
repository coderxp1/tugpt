/**
 * @file platform-media-jobs.ts
 * @description Media jobs port for the platform media executor, over the
 * public media RPCs (migration 20260927000001) with the process admin
 * client.
 *
 * A worker-side port of the web media jobs port
 * (`apps/web/src/lib/platform/media-bridge.ts`): the executor never
 * enqueues — submission is the chat/API side's job — so this port is the
 * execution subset: read the job row, record the provider's external id,
 * complete, and archive-as-failed. `complete_media_job` and
 * `archive_media_failed_job` settle the queue message themselves (delete /
 * archive inside the RPC), so the worker never deletes a message it has
 * driven to a terminal state.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const VIDEO_CAPABILITY_KEY = 'video.generate';
export const MEDIA_BUCKET = 'media';
/** The org feature flag that gates the capability (ADR-015 operative gate). */
export const MEDIA_GENERATION_FLAG = 'media_generation';

export interface MediaJobRow {
  id: string;
  organizationId: string;
  createdBy: string;
  status: string;
  prompt: string;
  params: Record<string, unknown>;
  promptId: string | null;
  pgmqMsgId: number | null;
}

export interface PlatformMediaJobsPort {
  getJob(jobId: string): Promise<MediaJobRow | null>;
  recordSubmission(jobId: string, externalId: string): Promise<void>;
  complete(jobId: string, resultPath: string): Promise<void>;
  archiveFailed(msgId: number, jobId: string, errorCode: string, detail?: string): Promise<void>;
  /** True when at least one platform job is claimable (queued, or processing with a recorded submission to resume). */
  hasClaimablePlatformJob(): Promise<boolean>;
}

export class MediaJobsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaJobsError';
  }
}

function rpcFail(error: { code?: string; message?: string }): never {
  throw new MediaJobsError(error.code ?? 'MEDIA_RPC_FAILED', error.message ?? 'media RPC failed');
}

/**
 * Platform jobs are the ones the platform submit path enqueues: their
 * params carry TuGPT's capability key and the platform source marker —
 * never provider identity. Everything else on the shared `media_jobs`
 * queue belongs to another lane's consumer.
 */
export function isPlatformMediaJob(job: Pick<MediaJobRow, 'params'>): boolean {
  return job.params.source === 'platform' && job.params.capability === VIDEO_CAPABILITY_KEY;
}

export function createPlatformMediaJobsPort(db: SupabaseClient): PlatformMediaJobsPort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = db as any;
  return {
    async getJob(jobId) {
      const { data, error } = await client.from('media_generation_jobs')
        .select('id, organization_id, created_by, status, prompt, params, prompt_id, pgmq_msg_id')
        .eq('id', jobId).maybeSingle();
      if (error) return rpcFail(error);
      if (!data) return null;
      return {
        id: data.id, organizationId: data.organization_id, createdBy: data.created_by, status: data.status,
        prompt: data.prompt, params: (data.params ?? {}) as Record<string, unknown>,
        promptId: data.prompt_id ?? null, pgmqMsgId: data.pgmq_msg_id ?? null,
      };
    },
    async recordSubmission(jobId, externalId) {
      const { error } = await client.rpc('record_media_submission', { p_job_id: jobId, p_prompt_id: externalId });
      if (error) return rpcFail(error);
    },
    async complete(jobId, resultPath) {
      const { error } = await client.rpc('complete_media_job', { p_job_id: jobId, p_result_path: resultPath, p_gpu_seconds: null });
      if (error) return rpcFail(error);
    },
    async archiveFailed(msgId, jobId, errorCode, detail) {
      const { error } = await client.rpc('archive_media_failed_job', {
        p_msg_id: msgId, p_media_job_id: jobId, p_error_code: errorCode, p_provider_error_detail: detail ?? null,
      });
      if (error) return rpcFail(error);
    },
    async hasClaimablePlatformJob() {
      const { data, error } = await client.from('media_generation_jobs')
        .select('id, status, params, prompt_id')
        .in('status', ['queued', 'processing'])
        .order('created_at', { ascending: true })
        .limit(25);
      if (error) return rpcFail(error);
      const rows = (data ?? []) as { status: string; params: Record<string, unknown> | null; prompt_id: string | null }[];
      return rows.some((r) => {
        const params = (r.params ?? {}) as Record<string, unknown>;
        if (params.source !== 'platform' || params.capability !== VIDEO_CAPABILITY_KEY) return false;
        // A processing job is only claimable work for this executor when a
        // submission was already recorded (resume) — a processing job with
        // no external id is either mid-claim by the claim RPC or wedged;
        // the queue redelivery path reconciles it, not this pre-check.
        return r.status === 'queued' || r.prompt_id != null;
      });
    },
  };
}
