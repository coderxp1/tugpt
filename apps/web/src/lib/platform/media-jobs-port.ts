/**
 * MediaJobsPort over the public media RPCs (migration 20260927000001),
 * for hosts that hold a trusted server-side client (the sso-control
 * client in web). enqueue is the thin public wrapper over
 * private.enqueue_media_job: it membership-checks the user and applies
 * the media_generation feature gate inside the database, so a caller
 * cannot enqueue for an organization the user is not a member of, nor
 * while the capability flag is off.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MediaJobRow, MediaJobsPort } from './media-bridge';

interface RpcRow { job_id?: unknown; already_exists?: unknown; pgmq_msg_id?: unknown }

export function createMediaJobsPort(db: SupabaseClient): MediaJobsPort {
  return {
    async enqueue(input) {
      const { data, error } = await db.rpc('enqueue_media_job', {
        p_user_id: input.userId,
        p_organization_id: input.organizationId,
        p_kind: 'video',
        p_prompt: input.prompt,
        p_params: input.params,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
      if (error) throw new Error(`enqueue_media_job failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null;
      if (!row || typeof row.job_id !== 'string') throw new Error('enqueue_media_job returned no job');
      return {
        jobId: row.job_id,
        alreadyExists: row.already_exists === true,
        pgmqMsgId: typeof row.pgmq_msg_id === 'number' ? row.pgmq_msg_id : null,
      };
    },
    async getJob(jobId) {
      const { data, error } = await db.from('media_generation_jobs').select('*').eq('id', jobId).maybeSingle();
      if (error) throw new Error(`media job read failed: ${error.message}`);
      if (!data) return null;
      const d = data as Record<string, unknown>;
      const row: MediaJobRow = {
        id: String(d.id),
        organizationId: String(d.organization_id),
        createdBy: String(d.created_by ?? d.requested_by ?? ''),
        status: String(d.status),
        prompt: String(d.prompt ?? ''),
        params: (d.params && typeof d.params === 'object' ? d.params : {}) as Record<string, unknown>,
        promptId: typeof d.prompt_id === 'string' ? d.prompt_id : null,
        pgmqMsgId: typeof d.pgmq_msg_id === 'number' ? d.pgmq_msg_id : null,
      };
      return row;
    },
    async recordSubmission(jobId, externalId) {
      const { error } = await db.rpc('record_media_submission', { p_job_id: jobId, p_prompt_id: externalId });
      if (error) throw new Error(`record_media_submission failed: ${error.message}`);
    },
    async complete(jobId, resultPath) {
      const { error } = await db.rpc('complete_media_job', { p_job_id: jobId, p_result_path: resultPath });
      if (error) throw new Error(`complete_media_job failed: ${error.message}`);
    },
    async archiveFailed(msgId, jobId, errorCode, detail) {
      const { error } = await db.rpc('archive_media_failed_job', {
        p_msg_id: msgId, p_media_job_id: jobId, p_error_code: errorCode, p_provider_error_detail: detail ?? null,
      });
      if (error) throw new Error(`archive_media_failed_job failed: ${error.message}`);
    },
  };
}
