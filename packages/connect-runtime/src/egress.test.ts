import { describe, it, expect } from 'vitest';
import { decideActivation, isEgressConfigured, probeEgressProxy, verifyEgressEnforced } from './egress.js';

const reachable = (async () => new Response(null, { status: 405 })) as unknown as typeof fetch;
const unreachable = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

describe('isEgressConfigured', () => {
  it('is true when the proxy URL is set', () => {
    expect(isEgressConfigured({ CONNECT_EGRESS_PROXY: 'http://egress-proxy:3128' })).toBe(true);
  });
  it('is false when unset', () => {
    expect(isEgressConfigured({})).toBe(false);
  });
  it('is false when blank', () => {
    expect(isEgressConfigured({ CONNECT_EGRESS_PROXY: '   ' })).toBe(false);
  });
});

describe('probeEgressProxy', () => {
  it('is reachable when the proxy responds', async () => {
    expect(await probeEgressProxy('http://proxy', reachable)).toBe(true);
  });
  it('is unreachable when the connection fails', async () => {
    expect(await probeEgressProxy('http://proxy', unreachable)).toBe(false);
  });
});

describe('verifyEgressEnforced', () => {
  it('is false when configured but unreachable (fail closed)', async () => {
    expect(await verifyEgressEnforced({ CONNECT_EGRESS_PROXY: 'http://proxy' }, unreachable)).toBe(false);
  });
  it('is true when configured and reachable', async () => {
    expect(await verifyEgressEnforced({ CONNECT_EGRESS_PROXY: 'http://proxy' }, reachable)).toBe(true);
  });
});

describe('decideActivation', () => {
  const authorized = { role: 'owner', snapshotApproved: true, egressEnforced: true };

  it('allows activation when role, approval and egress all hold', () => {
    expect(decideActivation(authorized)).toEqual({ ok: true });
  });
  it('rejects unauthorized activation', () => {
    expect(decideActivation({ ...authorized, role: 'member' }).ok).toBe(false);
  });
  it('rejects activation when no snapshot is approved', () => {
    expect(decideActivation({ ...authorized, snapshotApproved: false }).ok).toBe(false);
  });
  it('rejects activation when egress is not verified (fail closed)', () => {
    const d = decideActivation({ ...authorized, egressEnforced: false });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.reason).toContain('egress enforcement');
  });
});
