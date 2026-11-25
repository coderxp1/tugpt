/**
 * Platform media bridge (B7) against labelled fakes. Proves the lifecycle
 * order — audit before the billable submit, external id persisted BEFORE
 * the first poll, exact tenant result key, completion — and the failure
 * discipline: provider failure archives the job with a typed code and
 * nothing ever falls back to another renderer.
 */
import { describe, expect, it } from 'vitest';
import {
  runPlatformVideoJob, submitPlatformVideoRequest, MediaBridgeError,
  type MediaBridgeDeps, type MediaJobRow,
} from './media-bridge';
import type { PlatformRepository } from './platform-repo';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const JOB = '10000000-0000-4000-8000-000000000001';
const EP = 'e0000000-0000-4000-8000-000000000001';

const jobRow: MediaJobRow = {
  id: JOB, organizationId: ORG, createdBy: 'u-1', status: 'processing',
  prompt: 'a bakery at dawn', params: { capability: 'video.generate', aspectRatio: '9:16' },
  promptId: null, pgmqMsgId: 42,
};

function makeDeps(script: Record<string, unknown>[], opts: { auditThrows?: boolean } = {}) {
  const order: string[] = [];
  const archived: { code: string }[] = [];
  const stored: { path: string }[] = [];
  let polls = 0;
  const repo = {
    getBinding: async () => ({
      capabilityKey: 'video.generate', endpointId: EP, toolName: 'generate_video', enabled: true,
      config: { statusTool: 'get_video', submitArgs: { prompt: '{{prompt}}', ratio: '{{aspectRatio}}' }, statusArgs: { video_id: '{{externalId}}' } },
    }),
  } as unknown as PlatformRepository;
  const deps: MediaBridgeDeps = {
    repo,
    caller: {
      callTool: async (_ep: string, tool: string) => {
        if (tool === 'generate_video') { order.push('submit'); return { ok: true, data: { content: JSON.stringify({ video_id: 'vid-9', status: 'processing' }) } } as never; }
        order.push('poll');
        const payload = script[Math.min(polls, script.length - 1)];
        polls += 1;
        return { ok: true, data: { content: JSON.stringify(payload) } } as never;
      },
    },
    jobs: {
      enqueue: async () => ({ jobId: JOB, alreadyExists: false, pgmqMsgId: 42 }),
      getJob: async () => jobRow,
      recordSubmission: async () => { order.push('record'); },
      complete: async () => { order.push('complete'); },
      archiveFailed: async (_m: number, _j: string, code: string) => { archived.push({ code }); order.push('archive'); },
    },
    fetchBinary: async () => { order.push('download'); return { bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' }; },
    store: async (path: string) => { stored.push({ path }); order.push('store'); },
    sleep: async () => undefined,
    audit: async () => { order.push('audit'); if (opts.auditThrows) throw new Error('sink down'); },
  };
  return { deps, order, archived, stored };
}

describe('platform media bridge (B7)', () => {
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

  it('submit refuses when the capability binding is disabled', async () => {
    const { deps } = makeDeps([]);
    (deps.repo as unknown as { getBinding: () => Promise<null> }).getBinding = async () => null;
    await expect(submitPlatformVideoRequest(deps, { organizationId: ORG, userId: 'u-1', prompt: 'x' }))
      .rejects.toBeInstanceOf(MediaBridgeError);
  });
});
