/**
 * Platform media worker: claim discipline on the SHARED media_jobs queue,
 * execution-time gates, and message disposition — against a fake Supabase
 * client and a fake executor-deps factory (the port boundary, the same
 * pattern as the draft worker tests).
 */
import { describe, expect, it } from 'vitest';
import {
  PlatformMediaWorker,
  PlatformMediaNotConfiguredError,
  type PlatformMediaDepsFactory,
} from '../src/platform-media-worker';
import { createPlatformMediaJobsPort } from '../src/platform-media-jobs';
import type { PlatformMediaExecutorDeps } from '../src/platform-media-executor';
import type { PlatformMediaRepository } from '../src/platform-media-repo';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const JOB = '10000000-0000-4000-8000-000000000001';
const EP = 'e0000000-0000-4000-8000-000000000001';

interface RpcCall { name: string; args: Record<string, unknown> }

function platformRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB, organization_id: ORG, created_by: 'u-1', status: 'processing',
    prompt: 'a bakery at dawn',
    params: { capability: 'video.generate', source: 'platform', aspectRatio: '16:9' },
    prompt_id: null, pgmq_msg_id: 42,
    ...overrides,
  };
}

function makeFakeClient(opts: {
  jobRows?: Record<string, Record<string, unknown>>;
  claimableRows?: Record<string, unknown>[];
  flag?: boolean | 'error';
  readMessages?: Record<string, unknown>[];
}) {
  const calls: RpcCall[] = [];
  const jobRows = opts.jobRows ?? {};
  const client = {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      switch (name) {
        case 'is_feature_enabled':
          if (opts.flag === 'error') return { data: null, error: { code: 'XX000', message: 'db down' } };
          return { data: opts.flag !== false, error: null };
        case 'read_media_jobs':
          return { data: opts.readMessages ?? [], error: null };
        case 'set_media_visibility':
        case 'delete_media_job':
          return { data: true, error: null };
        default:
          return { data: null, error: null };
      }
    },
    from: (_table: string) => {
      const filters: Record<string, unknown> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const row = typeof filters.id === 'string' ? jobRows[filters.id] : undefined;
          return { data: row ?? null, error: null };
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: opts.claimableRows ?? [], error: null }),
      };
      return chain;
    },
  };
  return client;
}

function happyDepsFactory(client: ReturnType<typeof makeFakeClient>): PlatformMediaDepsFactory {
  return async (): Promise<PlatformMediaExecutorDeps> => ({
    repo: {
      getBinding: async () => ({
        capabilityKey: 'video.generate', endpointId: EP, toolName: 'generate_video', enabled: true,
        config: { statusTool: 'get_video' },
      }),
    } as unknown as PlatformMediaRepository,
    caller: {
      callTool: async (_ep: string, tool: string) => (tool === 'generate_video'
        ? { ok: true, data: { content: JSON.stringify({ video_id: 'vid-9' }) } } as never
        : { ok: true, data: { content: JSON.stringify({ status: 'completed', video_url: 'https://cdn.example.test/v.mp4' }) } } as never),
    },
    jobs: createPlatformMediaJobsPort(client as never),
    fetchBinary: async () => ({ bytes: new Uint8Array([1]), contentType: 'video/mp4' }),
    store: async () => undefined,
    sleep: async () => undefined,
    audit: async () => undefined,
  });
}

function makeWorker(client: ReturnType<typeof makeFakeClient>, factory: PlatformMediaDepsFactory) {
  return new PlatformMediaWorker(client as never, factory, {
    pollIntervalMs: 5000,
    visibilityTimeoutSeconds: 600,
    heartbeatIntervalMs: 600_000,
    transientBackoffSeconds: 30,
  });
}

const message = { msgId: 42n, readCt: 1, payload: { mediaJobId: JOB }, enqueuedAt: '', vt: '' };
const rpcNames = (c: ReturnType<typeof makeFakeClient>) => c.calls.map((x) => x.name);
const rpcCall = (c: ReturnType<typeof makeFakeClient>, name: string) => c.calls.find((x) => x.name === name);

describe('PlatformMediaWorker', () => {
  it('never touches the shared queue when no platform job is claimable', async () => {
    const client = makeFakeClient({ claimableRows: [] });
    const worker = makeWorker(client, happyDepsFactory(client));
    await worker.pollOnce();
    expect(rpcNames(client)).not.toContain('read_media_jobs');
  });

  it('releases a foreign (non-platform) job untouched: no execution, no failure', async () => {
    const client = makeFakeClient({
      jobRows: { [JOB]: platformRow({ params: { source: 'comfyui', workflow: 'flux' } }) },
    });
    let factoryCalls = 0;
    const worker = makeWorker(client, async () => { factoryCalls += 1; throw new Error('must not be called'); });
    await worker.processMessage(message);
    const release = rpcCall(client, 'set_media_visibility');
    expect(release?.args).toMatchObject({ p_msg_id: '42', p_visibility_timeout_seconds: 5 });
    expect(rpcNames(client)).not.toContain('archive_media_failed_job');
    expect(factoryCalls).toBe(0);
  });

  it('archives with ENTITLEMENT_DISABLED when the flag is off at execution time', async () => {
    const client = makeFakeClient({ jobRows: { [JOB]: platformRow() }, flag: false });
    let factoryCalls = 0;
    const worker = makeWorker(client, async () => { factoryCalls += 1; throw new Error('must not be called'); });
    await worker.processMessage(message);
    const archive = rpcCall(client, 'archive_media_failed_job');
    expect(archive?.args).toMatchObject({ p_media_job_id: JOB, p_error_code: 'ENTITLEMENT_DISABLED' });
    expect(factoryCalls).toBe(0);
  });

  it('backs off without executing when the flag state is unverifiable', async () => {
    const client = makeFakeClient({ jobRows: { [JOB]: platformRow() }, flag: 'error' });
    const worker = makeWorker(client, happyDepsFactory(client));
    await worker.processMessage(message);
    const release = rpcCall(client, 'set_media_visibility');
    expect(release?.args).toMatchObject({ p_msg_id: '42', p_visibility_timeout_seconds: 30 });
    expect(rpcNames(client)).not.toContain('archive_media_failed_job');
    expect(rpcNames(client)).not.toContain('record_media_submission');
  });

  it('drives a platform job to completion: submission recorded before completion settles it', async () => {
    const client = makeFakeClient({ jobRows: { [JOB]: platformRow() }, flag: true });
    const worker = makeWorker(client, happyDepsFactory(client));
    await worker.processMessage(message);
    const names = rpcNames(client);
    expect(names).toContain('record_media_submission');
    expect(names).toContain('complete_media_job');
    expect(names.indexOf('record_media_submission')).toBeLessThan(names.indexOf('complete_media_job'));
    expect(names).not.toContain('archive_media_failed_job');
    // Terminal states settle the message inside the RPCs: no release, no delete.
    expect(names).not.toContain('set_media_visibility');
    expect(names).not.toContain('delete_media_job');
  });

  it('deletes a malformed message that names no job', async () => {
    const client = makeFakeClient({});
    const worker = makeWorker(client, happyDepsFactory(client));
    await worker.processMessage({ ...message, payload: {} });
    expect(rpcNames(client)).toContain('delete_media_job');
  });

  it('archives with PLATFORM_NOT_CONFIGURED when the track is unconfigured', async () => {
    const client = makeFakeClient({ jobRows: { [JOB]: platformRow() }, flag: true });
    const worker = makeWorker(client, async () => {
      throw new PlatformMediaNotConfiguredError('the platform broker client is not configured');
    });
    await worker.processMessage(message);
    const archive = rpcCall(client, 'archive_media_failed_job');
    expect(archive?.args).toMatchObject({ p_media_job_id: JOB, p_error_code: 'PLATFORM_NOT_CONFIGURED' });
  });
});
