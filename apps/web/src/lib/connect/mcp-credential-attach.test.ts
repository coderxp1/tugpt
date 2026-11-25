/**
 * attachStaticCredential orchestration (ADR-021 R1/R2): begin -> broker store
 * -> complete, with the fail compensation on any post-begin failure. Fakes are
 * labelled stand-ins for the repository and the broker; the real repo error
 * mapping is covered by external-mcp-repo tests and the pgTAP suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { attachStaticCredential, type StaticSecretStore } from './mcp-credential-attach';
import {
  AuthAlreadyAttachedError,
  type ExternalMcpRepository,
} from './external-mcp-repo';

const ORG = 'o1';
const EP = 'e1';
const CONN = 'c1';

function fakeRepo(overrides: Partial<ExternalMcpRepository> = {}) {
  return {
    beginStaticCredential: vi.fn(async () => CONN),
    completeStaticCredential: vi.fn(async () => true),
    failStaticCredential: vi.fn(async () => true),
    ...overrides,
  } as unknown as ExternalMcpRepository & {
    beginStaticCredential: ReturnType<typeof vi.fn>;
    completeStaticCredential: ReturnType<typeof vi.fn>;
    failStaticCredential: ReturnType<typeof vi.fn>;
  };
}

function fakeBroker(result: Awaited<ReturnType<StaticSecretStore['storeStaticSecret']>>) {
  return { storeStaticSecret: vi.fn(async () => result) } satisfies StaticSecretStore;
}

describe('attachStaticCredential', () => {
  it('happy path: begins, stores once with the broker scope, completes', async () => {
    const repo = fakeRepo();
    const broker = fakeBroker({ ok: true, value: { credentialVersion: 1 } });
    const r = await attachStaticCredential({ repo, broker, organizationId: ORG, endpointId: EP, secret: 's3cret' });
    expect(r).toEqual({ ok: true, connectionId: CONN });
    expect(broker.storeStaticSecret).toHaveBeenCalledTimes(1);
    expect(broker.storeStaticSecret).toHaveBeenCalledWith({ organizationId: ORG, connectionId: CONN }, 's3cret');
    expect(repo.completeStaticCredential).toHaveBeenCalledWith(ORG, CONN);
    expect(repo.failStaticCredential).not.toHaveBeenCalled();
  });

  it('broker store failure: compensates with fail and reports stage=store', async () => {
    const repo = fakeRepo();
    const broker = fakeBroker({ ok: false, code: 'UNAVAILABLE' });
    const r = await attachStaticCredential({ repo, broker, organizationId: ORG, endpointId: EP, secret: 's3cret' });
    expect(r).toEqual({ ok: false, stage: 'store', code: 'UNAVAILABLE' });
    expect(repo.failStaticCredential).toHaveBeenCalledWith(ORG, EP, CONN);
    expect(repo.completeStaticCredential).not.toHaveBeenCalled();
  });

  it('complete returning false: compensates and reports stage=complete', async () => {
    const repo = fakeRepo({ completeStaticCredential: vi.fn(async () => false) });
    const broker = fakeBroker({ ok: true, value: { credentialVersion: 1 } });
    const r = await attachStaticCredential({ repo, broker, organizationId: ORG, endpointId: EP, secret: 's3cret' });
    expect(r).toEqual({ ok: false, stage: 'complete', code: 'COMPLETE_FAILED' });
    expect(repo.failStaticCredential).toHaveBeenCalledWith(ORG, EP, CONN);
  });

  it('already attached: reports stage=begin without touching the broker', async () => {
    const repo = fakeRepo({
      beginStaticCredential: vi.fn(async () => {
        throw new AuthAlreadyAttachedError();
      }),
    });
    const broker = fakeBroker({ ok: true, value: { credentialVersion: 1 } });
    const r = await attachStaticCredential({ repo, broker, organizationId: ORG, endpointId: EP, secret: 's3cret' });
    expect(r).toEqual({ ok: false, stage: 'begin', code: 'AUTH_ALREADY_ATTACHED' });
    expect(broker.storeStaticSecret).not.toHaveBeenCalled();
    expect(repo.failStaticCredential).not.toHaveBeenCalled();
  });

  it('compensation failure does not mask the original store failure', async () => {
    const repo = fakeRepo({
      failStaticCredential: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const broker = fakeBroker({ ok: false, code: 'UNAVAILABLE' });
    const r = await attachStaticCredential({ repo, broker, organizationId: ORG, endpointId: EP, secret: 's3cret' });
    expect(r).toEqual({ ok: false, stage: 'store', code: 'UNAVAILABLE' });
  });
});
