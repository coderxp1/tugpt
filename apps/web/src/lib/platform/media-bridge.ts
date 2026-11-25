/**
 * Platform media bridge (Plan B7, ADR-022 D8).
 *
 * Turns an entitled org's video.generate request into a media_generation_jobs
 * row and executes it against the platform connection: submit through the
 * B5 platform caller, PERSIST the external id (record_media_submission)
 * before any polling, poll the binding's status tool, download the finished
 * MP4 through the egress fetch, store it at the exact tenant key the media
 * RPCs require (<org>/<job>.mp4 in the media bucket), and complete the job.
 *
 * Hard rules: a provider failure fails the job with a typed error — there
 * is NO fallback renderer (paul's standing rule). The audit hook, when
 * wired, runs BEFORE the billable submit; if it throws, the provider is
 * never called (fail-closed for billable operations). Job params carry
 * only the TuGPT capability key — never provider identity. Per-job credit
 * attribution lands with B8's verified metering; the bridge forwards raw
 * provider payloads to the caller's audit hook for that purpose.
 *
 * The HeyGen-specific tool names and payload paths are NOT hardcoded: they
 * live in the operator's capability binding config, set after discovery
 * against the approved snapshot.
 */
import type { TypedSupabaseClient } from '@tugpt/database';
import type { ToolOutput } from '@tugpt/connect-runtime';
import type { PlatformRepository } from './platform-repo';
import { PlatformResolveError } from './platform-resolver';

export const VIDEO_CAPABILITY_KEY = 'video.generate';
export const MEDIA_BUCKET = 'media';

export interface VideoBindingConfig {
  statusTool?: string;
  submitArgs?: Record<string, string>;
  statusArgs?: Record<string, string>;
  idPath?: string;
  statusPath?: string;
  resultUrlPath?: string;
  doneValues?: string[];
  failedValues?: string[];
  maxPolls?: number;
  pollIntervalMs?: number;
}

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

export interface MediaJobsPort {
  enqueue(input: { userId: string; organizationId: string; prompt: string; params: Record<string, unknown>; idempotencyKey?: string }):
    Promise<{ jobId: string; alreadyExists: boolean; pgmqMsgId: number | null }>;
  getJob(jobId: string): Promise<MediaJobRow | null>;
  recordSubmission(jobId: string, externalId: string): Promise<void>;
  complete(jobId: string, resultPath: string): Promise<void>;
  archiveFailed(msgId: number, jobId: string, errorCode: string, detail?: string): Promise<void>;
}

export class MediaBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaBridgeError';
  }
}

function rpcFail(error: { message?: string }): never {
  throw new MediaBridgeError('MEDIA_RPC_FAILED', error.message ?? 'media RPC failed');
}

export function createMediaJobsPort(admin: TypedSupabaseClient): MediaJobsPort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as any;
  return {
    async enqueue(input) {
      const { data, error } = await db.rpc('enqueue_media_job', {
        p_user_id: input.userId, p_organization_id: input.organizationId, p_kind: 'video',
        p_prompt: input.prompt, p_params: input.params, p_idempotency_key: input.idempotencyKey ?? null,
      });
      if (error) return rpcFail(error);
      const row = (Array.isArray(data) ? data[0] : data) as { job_id: string; already_exists: boolean; pgmq_msg_id: number | null };
      return { jobId: row.job_id, alreadyExists: row.already_exists === true, pgmqMsgId: row.pgmq_msg_id ?? null };
    },
    async getJob(jobId) {
      const { data, error } = await db.from('media_generation_jobs')
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
      const { error } = await db.rpc('record_media_submission', { p_job_id: jobId, p_prompt_id: externalId });
      if (error) return rpcFail(error);
    },
    async complete(jobId, resultPath) {
      const { error } = await db.rpc('complete_media_job', { p_job_id: jobId, p_result_path: resultPath, p_gpu_seconds: null });
      if (error) return rpcFail(error);
    },
    async archiveFailed(msgId, jobId, errorCode, detail) {
      const { error } = await db.rpc('archive_media_failed_job', {
        p_msg_id: msgId, p_media_job_id: jobId, p_error_code: errorCode, p_provider_error_detail: detail ?? null,
      });
      if (error) return rpcFail(error);
    },
  };
}

export interface PlatformCallerPort {
  callTool(endpointId: string, toolName: string, args: Record<string, unknown>): Promise<ToolOutput>;
}

export interface MediaBridgeDeps {
  repo: PlatformRepository;
  caller: PlatformCallerPort;
  jobs: MediaJobsPort;
  /** Downloads the finished media (through the egress proxy in production). */
  fetchBinary(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Stores the media at the tenant key in the media bucket. */
  store(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Dual-attribution audit hook (org/user + platform connection). Fail-closed before billable calls. */
  audit?(event: Record<string, unknown>): Promise<void>;
}

function renderTemplate(template: Record<string, string> | undefined, vars: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template ?? {})) {
    out[k] = v.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? '');
  }
  return out;
}

function parseToolJson(out: ToolOutput): Record<string, unknown> {
  if (!out.ok) throw new MediaBridgeError('PLATFORM_CALL_FAILED', `platform tool call failed (${out.code})`);
  const data = (out as { data?: unknown }).data as { content?: unknown } | undefined;
  const text = typeof data?.content === 'string' ? data.content : '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new MediaBridgeError('PLATFORM_RESULT_MALFORMED', 'the platform tool did not return a JSON object');
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function configOf(raw: Record<string, unknown>): VideoBindingConfig {
  return raw as VideoBindingConfig;
}

/** Enqueue a video.generate request. Entitlement + quota are the caller's gates (B6 + media quota). */
export async function submitPlatformVideoRequest(
  deps: Pick<MediaBridgeDeps, 'repo' | 'jobs'>,
  input: { organizationId: string; userId: string; prompt: string; aspectRatio?: string; idempotencyKey?: string },
): Promise<{ jobId: string; alreadyExists: boolean }> {
  const binding = await deps.repo.getBinding(VIDEO_CAPABILITY_KEY);
  if (!binding || !binding.enabled) {
    throw new MediaBridgeError('CAPABILITY_UNAVAILABLE', 'the video generation capability is not available');
  }
  const enqueued = await deps.jobs.enqueue({
    userId: input.userId, organizationId: input.organizationId, prompt: input.prompt,
    params: { capability: VIDEO_CAPABILITY_KEY, aspectRatio: input.aspectRatio ?? '16:9', source: 'platform' },
    idempotencyKey: input.idempotencyKey,
  });
  return { jobId: enqueued.jobId, alreadyExists: enqueued.alreadyExists };
}

/**
 * Execute one CLAIMED (status 'processing') platform video job to a
 * terminal state. Returns the terminal outcome; provider failures archive
 * the job as failed with a typed code — never a fallback render.
 */
export async function runPlatformVideoJob(
  deps: MediaBridgeDeps,
  job: MediaJobRow,
): Promise<{ outcome: 'completed'; resultPath: string } | { outcome: 'failed'; errorCode: string }> {
  const fail = async (errorCode: string, detail?: string) => {
    if (job.pgmqMsgId != null) {
      await deps.jobs.archiveFailed(job.pgmqMsgId, job.id, errorCode, detail).catch(() => undefined);
    }
    return { outcome: 'failed' as const, errorCode };
  };

  const binding = await deps.repo.getBinding(VIDEO_CAPABILITY_KEY);
  if (!binding || !binding.enabled) return fail('CAPABILITY_UNAVAILABLE', 'binding missing or disabled');
  const cfg = configOf(binding.config);
  const aspectRatio = typeof job.params.aspectRatio === 'string' ? job.params.aspectRatio : '16:9';

  // Fail-closed audit BEFORE the billable submit.
  if (deps.audit) {
    try {
      await deps.audit({
        phase: 'submit', organizationId: job.organizationId, userId: job.createdBy, jobId: job.id,
        capability: VIDEO_CAPABILITY_KEY, endpointId: binding.endpointId, toolName: binding.toolName,
      });
    } catch {
      return fail('AUDIT_UNAVAILABLE', 'the audit sink rejected the submission record');
    }
  }

  let externalId = job.promptId;
  if (!externalId) {
    let submitPayload: Record<string, unknown>;
    try {
      const out = await deps.caller.callTool(
        binding.endpointId, binding.toolName,
        renderTemplate(cfg.submitArgs ?? { prompt: '{{prompt}}' }, { prompt: job.prompt, aspectRatio }),
      );
      submitPayload = parseToolJson(out);
    } catch (e) {
      if (e instanceof PlatformResolveError) return fail(e.code, e.message);
      if (e instanceof MediaBridgeError) return fail(e.code, e.message);
      return fail('PLATFORM_SUBMIT_FAILED', e instanceof Error ? e.message : 'submit failed');
    }
    const idValue = getPath(submitPayload, cfg.idPath ?? 'video_id') ?? getPath(submitPayload, 'id');
    if (typeof idValue !== 'string' || idValue === '') {
      // A synchronous tool may return the finished URL directly.
      const directUrl = getPath(submitPayload, cfg.resultUrlPath ?? 'video_url');
      if (typeof directUrl !== 'string' || directUrl === '') {
        return fail('PLATFORM_RESULT_MALFORMED', 'the submit result carried no external id and no result URL');
      }
      // complete_media_job requires a recorded submission; an inline result
      // records the job's own id as the (non-pollable) submission handle.
      await deps.jobs.recordSubmission(job.id, `inline:${job.id}`);
      return finishWithUrl(deps, job, directUrl, fail);
    }
    externalId = idValue;
    // Persist the external id BEFORE any polling (restart-safe resume).
    await deps.jobs.recordSubmission(job.id, externalId);
  }

  if (!cfg.statusTool) {
    return fail('PLATFORM_RESULT_MALFORMED', 'the binding has no status tool and the submit returned no result URL');
  }
  const doneValues = cfg.doneValues ?? ['completed', 'succeeded', 'complete', 'done'];
  const failedValues = cfg.failedValues ?? ['failed', 'error', 'cancelled'];
  const maxPolls = cfg.maxPolls ?? 40;
  const interval = cfg.pollIntervalMs ?? 15000;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    if (attempt > 0) await deps.sleep(interval);
    let payload: Record<string, unknown>;
    try {
      const out = await deps.caller.callTool(
        binding.endpointId, cfg.statusTool,
        renderTemplate(cfg.statusArgs ?? { video_id: '{{externalId}}' }, { externalId }),
      );
      payload = parseToolJson(out);
    } catch (e) {
      if (e instanceof PlatformResolveError) return fail(e.code, e.message);
      if (e instanceof MediaBridgeError) return fail(e.code, e.message);
      return fail('PLATFORM_POLL_FAILED', e instanceof Error ? e.message : 'poll failed');
    }
    const status = getPath(payload, cfg.statusPath ?? 'status');
    if (typeof status === 'string' && failedValues.includes(status)) {
      return fail('PLATFORM_GENERATION_FAILED', `provider reported status ${status}`);
    }
    if (typeof status === 'string' && doneValues.includes(status)) {
      const url = getPath(payload, cfg.resultUrlPath ?? 'video_url');
      if (typeof url !== 'string' || url === '') return fail('PLATFORM_RESULT_MALFORMED', 'completed without a result URL');
      return finishWithUrl(deps, job, url, fail);
    }
  }
  return fail('PLATFORM_TIMEOUT', `no terminal status after ${maxPolls} polls; the external id stays recorded for resume`);
}

async function finishWithUrl(
  deps: MediaBridgeDeps,
  job: MediaJobRow,
  url: string,
  fail: (errorCode: string, detail?: string) => Promise<{ outcome: 'failed'; errorCode: string }>,
): Promise<{ outcome: 'completed'; resultPath: string } | { outcome: 'failed'; errorCode: string }> {
  const resultPath = `${job.organizationId}/${job.id}.mp4`;
  try {
    const media = await deps.fetchBinary(url);
    await deps.store(resultPath, media.bytes, media.contentType || 'video/mp4');
    await deps.jobs.complete(job.id, resultPath);
  } catch (e) {
    return fail('MEDIA_DELIVERY_FAILED', e instanceof Error ? e.message : 'delivery failed');
  }
  if (deps.audit) {
    await deps.audit({
      phase: 'completed', organizationId: job.organizationId, userId: job.createdBy, jobId: job.id,
      capability: VIDEO_CAPABILITY_KEY, resultPath,
    }).catch(() => undefined);
  }
  return { outcome: 'completed', resultPath };
}
