/**
 * Platform capability chat tools (ADR-022 D6/D7): the toolset offers
 * generate_video only as a submit port; union routing keeps Connect
 * tools primary; nothing provider-shaped leaks into specs or describe.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildPlatformToolset, unionToolsets, type PlatformSubmitPort } from './platform-tools';
import { PLATFORM_CAPABILITY_DEFINITIONS, type EntitledCapability } from '@/lib/platform/capabilities';

const PLATFORM_TOOL_NAME = 'generate_video';
const ENTITLED: EntitledCapability = {
  capabilityKey: 'video.generate', toolName: PLATFORM_TOOL_NAME, displayName: 'Video generation',
  description: PLATFORM_CAPABILITY_DEFINITIONS[0].description, parameters: PLATFORM_CAPABILITY_DEFINITIONS[0].parameters,
  endpointId: 'endpoint-1', remoteToolName: 'remote_tool',
};
import { MediaBridgeError } from '@/lib/platform/media-bridge';
import type { ChatToolset } from './connect';

const SCOPE = { organizationId: 'org-1', userId: 'user-1', threadId: 'thread-1' };
const okPort = (): PlatformSubmitPort & { submit: ReturnType<typeof vi.fn> } => ({
  submit: vi.fn(async () => ({ jobId: 'job-1', alreadyExists: false })),
});

describe('buildPlatformToolset', () => {
  it('exposes one capability-shaped spec with no provider internals', () => {
    const ts = buildPlatformToolset(SCOPE, ENTITLED, okPort());
    expect(ts.specs).toHaveLength(1);
    expect(ts.specs[0].name).toBe(PLATFORM_TOOL_NAME);
    const blob = JSON.stringify(ts.specs) + JSON.stringify(ts.labels);
    expect(blob).not.toMatch(/heygen|platform_tool_endpoints|endpointId/i);
    expect(ts.describe(PLATFORM_TOOL_NAME)).toEqual({ capabilityKey: 'video.generate', providerName: 'TuGPT', providerKey: 'platform' });
    expect(ts.describe('other_tool')).toBeNull();
    expect(ts.approvalTarget(PLATFORM_TOOL_NAME)).toBeNull();
  });

  it('submits with a per-call idempotency key and reports the queued job', async () => {
    const port = okPort();
    const ts = buildPlatformToolset(SCOPE, ENTITLED, port);
    const r = await ts.execute({ id: 'call-9', name: PLATFORM_TOOL_NAME, arguments: { prompt: ' a shop owner opening her store ', aspectRatio: '9:16' } });
    expect(r.ok).toBe(true);
    expect(port.submit).toHaveBeenCalledWith({ prompt: 'a shop owner opening her store', aspectRatio: '9:16', idempotencyKey: 'chat:thread-1:call-9' });
    const body = JSON.parse(r.content) as { jobId: string; status: string };
    expect(body).toMatchObject({ jobId: 'job-1', status: 'queued' });
  });

  it('rejects invalid arguments before submitting', async () => {
    const port = okPort();
    const ts = buildPlatformToolset(SCOPE, ENTITLED, port);
    expect((await ts.execute({ id: 'c1', name: PLATFORM_TOOL_NAME, arguments: { prompt: '  ' } })).code).toBe('INVALID_ARGUMENTS');
    expect((await ts.execute({ id: 'c2', name: PLATFORM_TOOL_NAME, arguments: { prompt: 'ok', aspectRatio: '4:3' } })).code).toBe('INVALID_ARGUMENTS');
    expect((await ts.execute({ id: 'c3', name: 'nope', arguments: {} })).code).toBe('UNKNOWN_TOOL');
    expect(port.submit).not.toHaveBeenCalled();
  });

  it('maps bridge failures to typed codes and hides unexpected errors', async () => {
    const failing: PlatformSubmitPort = { submit: vi.fn(async () => { throw new MediaBridgeError('CAPABILITY_UNAVAILABLE', 'nope'); }) };
    const r = await buildPlatformToolset(SCOPE, ENTITLED, failing).execute({ id: 'c1', name: PLATFORM_TOOL_NAME, arguments: { prompt: 'x' } });
    expect(r).toMatchObject({ ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    const boom: PlatformSubmitPort = { submit: vi.fn(async () => { throw new Error('db exploded'); }) };
    const r2 = await buildPlatformToolset(SCOPE, ENTITLED, boom).execute({ id: 'c1', name: PLATFORM_TOOL_NAME, arguments: { prompt: 'x' } });
    expect(r2.code).toBe('UNAVAILABLE');
    expect(r2.content).not.toContain('db exploded');
  });
});

describe('unionToolsets', () => {
  const primary: ChatToolset = {
    specs: [{ name: 'calendar_read', description: 'd', parameters: {} }],
    labels: ['Google: calendar'],
    describe: (n) => (n === 'calendar_read' ? { capabilityKey: 'calendar.read', providerName: 'Google', providerKey: 'google' } : null),
    approvalTarget: () => null,
    execute: async () => ({ ok: true, content: '{"from":"primary"}' }),
  };

  it('routes by name, primary wins conflicts, labels and specs merge', async () => {
    const extra = buildPlatformToolset(SCOPE, ENTITLED, okPort());
    const u = unionToolsets(primary, extra);
    expect(u.specs.map((s) => s.name)).toEqual(['calendar_read', PLATFORM_TOOL_NAME]);
    expect(u.labels).toHaveLength(2);
    expect((await u.execute({ id: 'a', name: 'calendar_read', arguments: {} })).content).toContain('primary');
    expect((await u.execute({ id: 'b', name: PLATFORM_TOOL_NAME, arguments: { prompt: 'x' } })).ok).toBe(true);
    expect(u.describe(PLATFORM_TOOL_NAME)?.providerKey).toBe('platform');
    expect(u.describe('calendar_read')?.providerKey).toBe('google');
    const clash = unionToolsets(extra, primary);
    expect(clash.specs.filter((s) => s.name === PLATFORM_TOOL_NAME)).toHaveLength(1);
  });
});
