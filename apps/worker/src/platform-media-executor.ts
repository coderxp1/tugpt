/**
 * @file platform-media-executor.ts
 * @description Executes one claimed platform video job to a terminal state.
 *
 * This is the production host implementation of the platform media bridge
 * (Plan B7, ADR-022 D8). The same state machine exists as library code in
 * web (`apps/web/src/lib/platform/media-bridge.ts`), where it has no
 * production caller — chat submits jobs and stops. This worker module is
 * the executor that library always pointed at ("generation itself happens
 * in the media pipeline, whose executor re-resolves the platform endpoint
 * per job and audits before the billable provider call"). It is ported
 * rather than imported because this repo does not import across apps; each
 * process carries its own adapters over the shared packages. The two
 * implementations must not diverge on the billable path — changes to the
 * lifecycle order or the typed codes land in both, or the web copy is
 * retired in favour of this one.
 *
 * The lifecycle, in order:
 *   1. Re-resolve the capability binding NOW (never trust submit-time
 *      state): binding present and enabled, or the job fails typed.
 *   2. Run the audit hook BEFORE the billable submit. If it throws, the
 *      provider is never called (fail-closed for billable operations).
 *   3. Submit through the platform caller (which re-resolves endpoint,
 *      approved snapshot and broker token per call), applying the
 *      binding's argument template to the job's spec.
 *   4. PERSIST the external id (record_media_submission) BEFORE any
 *      polling, so a crash mid-poll resumes instead of resubmitting —
 *      the provider bills on submission. A job that already carries an
 *      external id is resumed, never resubmitted. A synchronous tool that
 *      returns the finished URL directly skips polling entirely.
 *   5. Poll the binding's status tool until a terminal status, download
 *      the finished MP4 through the egress fetch, store it at the exact
 *      tenant key the media RPCs require (<org>/<job>.mp4), complete.
 *
 * Hard rules: a provider failure fails the job with a typed error — there
 * is NO fallback renderer (paul's standing rule). Job params carry only
 * the TuGPT capability key — never provider identity. Provider tool names
 * and payload paths are NOT hardcoded: they live in the operator's
 * capability binding config, set after discovery against the approved
 * snapshot.
 */
import type { ToolOutput } from '@tugpt/connect-runtime';
import type { PlatformMediaRepository } from './platform-media-repo.js';
import { PlatformResolveError } from './platform-media-resolver.js';
import { VIDEO_CAPABILITY_KEY, type MediaJobRow, type PlatformMediaJobsPort } from './platform-media-jobs.js';

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

export interface PlatformCallerPort {
  callTool(endpointId: string, toolName: string, args: Record<string, unknown>): Promise<ToolOutput>;
}

export interface PlatformMediaExecutorDeps {
  repo: PlatformMediaRepository;
  caller: PlatformCallerPort;
  jobs: PlatformMediaJobsPort;
  /** Downloads the finished media (through the egress proxy in production). */
  fetchBinary(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Stores the media at the tenant key in the media bucket. */
  store(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Dual-attribution audit hook (org/user + platform connection). Fail-closed before billable calls. */
  audit?(event: Record<string, unknown>): Promise<void>;
}

export class PlatformMediaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlatformMediaError';
  }
}

function renderTemplate(template: Record<string, string> | undefined, vars: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template ?? {})) {
    out[k] = v.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? '');
  }
  return out;
}

function parseToolJson(out: ToolOutput): Record<string, unknown> {
  if (!out.ok) throw new PlatformMediaError('PLATFORM_CALL_FAILED', `platform tool call failed (${out.code})`);
  const data = (out as { data?: unknown }).data as { content?: unknown } | undefined;
  const text = typeof data?.content === 'string' ? data.content : '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new PlatformMediaError('PLATFORM_RESULT_MALFORMED', 'the platform tool did not return a JSON object');
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function configOf(raw: Record<string, unknown>): VideoBindingConfig {
  return raw as VideoBindingConfig;
}

function paramString(params: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/**
 * Execute one CLAIMED (status 'processing') platform video job to a
 * terminal state. Returns the terminal outcome; provider failures archive
 * the job as failed with a typed code — never a fallback render.
 */
export async function runPlatformVideoJob(
  deps: PlatformMediaExecutorDeps,
  job: MediaJobRow,
): Promise<{ outcome: 'completed'; resultPath: string } | { outcome: 'failed'; errorCode: string }> {
  const fail = async (errorCode: string, detail?: string) => {
    if (job.pgmqMsgId != null) {
      await deps.jobs.archiveFailed(job.pgmqMsgId, job.id, errorCode, detail).catch(() => undefined);
    }
    return { outcome: 'failed' as const, errorCode };
  };

  // 1. Re-resolve the binding at execution time.
  const binding = await deps.repo.getBinding(VIDEO_CAPABILITY_KEY);
  if (!binding || !binding.enabled) return fail('CAPABILITY_UNAVAILABLE', 'binding missing or disabled');
  const cfg = configOf(binding.config);
  const vars: Record<string, string> = {
    prompt: job.prompt,
    aspectRatio: paramString(job.params, 'aspectRatio', 'aspect_ratio') || '16:9',
    durationSeconds: paramString(job.params, 'durationSeconds', 'duration_seconds'),
    referenceImageUrl: paramString(job.params, 'referenceImageUrl', 'reference_image_url'),
  };

  // 2. Fail-closed audit BEFORE the billable submit.
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
    // 3. Submit (the caller re-resolves endpoint/snapshot/token per call).
    let submitPayload: Record<string, unknown>;
    try {
      const out = await deps.caller.callTool(
        binding.endpointId, binding.toolName,
        renderTemplate(cfg.submitArgs ?? { prompt: '{{prompt}}' }, vars),
      );
      submitPayload = parseToolJson(out);
    } catch (e) {
      if (e instanceof PlatformResolveError) return fail(e.code, e.message);
      if (e instanceof PlatformMediaError) return fail(e.code, e.message);
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
    // 4. Persist the external id BEFORE any polling (restart-safe resume).
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
        renderTemplate(cfg.statusArgs ?? { video_id: '{{externalId}}' }, { ...vars, externalId }),
      );
      payload = parseToolJson(out);
    } catch (e) {
      if (e instanceof PlatformResolveError) return fail(e.code, e.message);
      if (e instanceof PlatformMediaError) return fail(e.code, e.message);
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
  deps: PlatformMediaExecutorDeps,
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
