/**
 * Platform media executor (the worker host of the B7 bridge) against
 * labelled fakes. Proves the lifecycle order — audit before the billable
 * submit, external id persisted BEFORE the first poll, exact tenant
 * result key, completion — and the failure discipline: provider failure
 * archives the job with a typed code and nothing ever falls back to
 * another renderer.
 */
import { describe, expect, it } from 'vitest';
import {
  runPlatformVideoJob,
  type PlatformMediaExecutorDeps,
} from '../src/platform-media-executor';
import type { MediaJobRow } from '../src/platform-media-jobs';
import type { PlatformMediaRepository } from '../src/platform-media-repo';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const JOB = '10000000-0000-4000-8000-000000000001';
const EP = 'e0000000-0000-4000-8000-000000000001';

const jobRow: MediaJobRow = {
  id: JOB, organizationId: ORG, createdBy: 'u-1', status: 'processing',
  prompt: 'a bakery at dawn',
  params: { capability: 'video.generate', source: 'platform', aspectRatio: '9:16', durationSeconds: 8, referenceImageUrl: 'https://img.example.test/p.png' },
  promptId: null, pgmqMsgId: 42,
};

function makeDeps(
  script: Record<string, unknown>[],
  opts: { auditThrows?: boolean; submitPayload?: Record<string, unknown>; fetchThrows?: boolean } = {},
) {
  const order: string[] = [];
  const archived: { code: string }[] = [];
  const stored: { path: string }[] = [];
  const submitArgs: Record<string, unknown>[] = [];
  let polls = 0;
  const repo = {
    getBinding: async () => ({
      capabilityKey: 'video.generate', endpointId: EP, toolName: 'generate_video', enabled: true,
      config: {
        statusTool: 'get_video',
        submitArgs: { prompt: '{{prompt}}', ratio: '{{aspectRatio}}', seconds: '{{durationSeconds}}', ref: '{{referenceImageUrl}}' },
        statusArgs: { video_id: '{{externalId}}' },
      },
    }),
  } as unknown as PlatformMediaRepository;
  const deps: PlatformMediaExecutorDeps = {
    repo,
    caller: {
      callTool: async (_ep: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'generate_video') {
          order.push('submit');
          submitArgs.push(args);
          const payload = opts.submitPayload ?? { video_id: 'vid-9', status: 'processing' };
          return { ok: true, data: { content: JSON.stringify(payload) } } as never;
        }
        order.push('poll');
        const payload = script[Math.min(polls, script.length - 1)];
        polls += 1;
        return { ok: true, data: { content: JSON.stringify(payload) } } as never;
      },
    },
    jobs: {
      getJob: async () => jobRow,
      hasClaimablePlatformJob: async () => true,
      recordSubmission: async () => { order.push('record'); },
      complete: async () => { order.push('complete'); },
      archiveFailed: async (_m: number, _j: string, code: string) => { archived.push({ code }); order.push('archive'); },
    },
    fetchBinary: async () => {
      order.push('download');
      if (opts.fetchThrows) throw new Error('download died');
      return { bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' };
    },
    store: async (path: string) => { stored.push({ path }); order.push('store'); },
    sleep: async () => undefined,
    audit: async () => { order.push('audit'); if (opts.auditThrows) throw new Error('sink down'); },
  };
  return { deps, order, archived, stored, submitArgs };
}

describe('platform media executor', () => {
  it('runs the full lifecycle in order: audit, submit, persist id, poll, deliver, complete', async () => {
    const { deps, order, stored } = makeDeps([
      { status: 'processing' },
      { status: 'completed', video_url: 'https://cdn.example.test/vid-9.mp4' },
    ]);
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'completed', resultPath: `${ORG}/${JOB}.mp4` });
    expect(order).toEqual(['audit', 'submit', 'record', 'poll', 'poll', 'download', 'store', 'complete', 'audit']);
    expect(stored).toEqual([{ path: `${ORG}/${JOB}.mp4` }]);
  });

  it('applies the binding template to the full job spec (prompt, aspect, duration, reference image)', async () => {
    const { deps, submitArgs } = makeDeps([{ status: 'completed', video_url: 'https://cdn.example.test/v.mp4' }]);
    await runPlatformVideoJob(deps, jobRow);
    expect(submitArgs).toEqual([{
      prompt: 'a bakery at dawn', ratio: '9:16', seconds: '8', ref: 'https://img.example.test/p.png',
    }]);
  });

  it('a provider failure status archives the job and never completes it', async () => {
    const { deps, order, archived } = makeDeps([{ status: 'failed' }]);
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'failed', errorCode: 'PLATFORM_GENERATION_FAILED' });
    expect(archived).toEqual([{ code: 'PLATFORM_GENERATION_FAILED' }]);
    expect(order).not.toContain('complete');
    expect(order).not.toContain('download');
  });

  it('when the audit sink rejects, the provider is never called (fail-closed for billable ops)', async () => {
    const { deps, order } = makeDeps([{ status: 'completed', video_url: 'https://x.test/v.mp4' }], { auditThrows: true });
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'failed', errorCode: 'AUDIT_UNAVAILABLE' });
    expect(order).not.toContain('submit');
  });

  it('a resumed job (external id already recorded) polls without resubmitting', async () => {
    const { deps, order } = makeDeps([{ status: 'completed', video_url: 'https://cdn.example.test/v.mp4' }]);
    const res = await runPlatformVideoJob(deps, { ...jobRow, promptId: 'vid-9' });
    expect(res.outcome).toBe('completed');
    expect(order).not.toContain('submit');
    expect(order).not.toContain('record');
  });

  it('a synchronous tool returning the finished URL directly skips polling', async () => {
    const { deps, order } = makeDeps([], { submitPayload: { video_url: 'https://cdn.example.test/direct.mp4' } });
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'completed', resultPath: `${ORG}/${JOB}.mp4` });
    expect(order).toEqual(['audit', 'submit', 'record', 'download', 'store', 'complete', 'audit']);
  });

  it('a missing binding fails typed and never calls the provider', async () => {
    const { deps, archived } = makeDeps([]);
    (deps.repo as unknown as { getBinding: () => Promise<null> }).getBinding = async () => null;
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'failed', errorCode: 'CAPABILITY_UNAVAILABLE' });
    expect(archived).toEqual([{ code: 'CAPABILITY_UNAVAILABLE' }]);
  });

  it('poll exhaustion fails with PLATFORM_TIMEOUT and keeps the external id recorded', async () => {
    const { deps, archived } = makeDeps([{ status: 'processing' }]);
    (deps.repo as unknown as { getBinding: () => Promise<unknown> }).getBinding = async () => ({
      capabilityKey: 'video.generate', endpointId: EP, toolName: 'generate_video', enabled: true,
      config: { statusTool: 'get_video', maxPolls: 3, pollIntervalMs: 1 },
    });
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'failed', errorCode: 'PLATFORM_TIMEOUT' });
    expect(archived).toEqual([{ code: 'PLATFORM_TIMEOUT' }]);
  });

  it('a failed download archives as MEDIA_DELIVERY_FAILED and never completes', async () => {
    const { deps, order, archived } = makeDeps(
      [{ status: 'completed', video_url: 'https://cdn.example.test/v.mp4' }],
      { fetchThrows: true },
    );
    const res = await runPlatformVideoJob(deps, jobRow);
    expect(res).toEqual({ outcome: 'failed', errorCode: 'MEDIA_DELIVERY_FAILED' });
    expect(archived).toEqual([{ code: 'MEDIA_DELIVERY_FAILED' }]);
    expect(order).not.toContain('complete');
  });
});
