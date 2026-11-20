/**
 * activateEndpoint: the database gate (20261120000008) must surface as distinct, fail-closed outcomes.
 *
 * activate_mcp_endpoint now refuses with SQLSTATE PT409 'SNAPSHOT_NOT_APPROVED' when the newest snapshot is not
 * approved or is revoked, and returns false when no such endpoint exists in the org. Before this change the repo
 * turned EVERY error into a generic Error (route: 500) and ignored a false result (route: 200 "active" for an
 * endpoint that was never updated). Required mapping:
 *   data true                         -> resolves
 *   data false / null                 -> EndpointNotFoundError       (404)
 *   PT409 SNAPSHOT_NOT_APPROVED       -> ActivationDeniedError       (409, not retried)
 *   42501                             -> RepoError('42501')          (403)
 *   anything else, incl. our timeout  -> DatabaseTimeoutError        (503, outcome unknown, re-read first)
 * The client is a labelled STAND-IN for postgrest-js rpc(): it returns the { data, error } envelope PostgREST
 * produces for each case. The real function is covered by supabase/tests/database/
 * mcp_activation_requires_approved_snapshot.test.sql (real Postgres) and by the real-stack probe.
 */
import { describe, expect, it } from 'vitest';
import {
  ActivationDeniedError, createExternalMcpRepository, DatabaseTimeoutError, EndpointNotFoundError, RepoError,
} from './external-mcp-repo';
import { endpointLookupFailure } from './endpoint-lookup-response';

const ORG = 'a3000000-0000-4000-8000-00000000000a';
const EP = 'a3000000-0000-4000-8000-0000000e0001';

function rpcClient(result: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    from() { throw new Error('activateEndpoint must not read tables directly'); },
    async rpc(fn: string, args: unknown) { calls.push({ fn, args }); return result; },
  };
  return { repo: createExternalMcpRepository(client as never), calls };
}

describe('activateEndpoint maps the database gate fail-closed', () => {
  it('true -> resolves, calling activate_mcp_endpoint with org + endpoint', async () => {
    const { repo, calls } = rpcClient({ data: true, error: null });
    await expect(repo.activateEndpoint(ORG, EP)).resolves.toBeUndefined();
    expect(calls).toEqual([{ fn: 'activate_mcp_endpoint', args: { p_organization_id: ORG, p_endpoint_id: EP } }]);
  });
  it('false (no such endpoint in this org) -> EndpointNotFoundError, never a silent success', async () => {
    await expect(rpcClient({ data: false, error: null }).repo.activateEndpoint(ORG, EP)).rejects.toBeInstanceOf(EndpointNotFoundError);
  });
  it('null data without error -> EndpointNotFoundError (unexpected envelope is not success)', async () => {
    await expect(rpcClient({ data: null, error: null }).repo.activateEndpoint(ORG, EP)).rejects.toBeInstanceOf(EndpointNotFoundError);
  });
  it('PT409 SNAPSHOT_NOT_APPROVED -> ActivationDeniedError', async () => {
    await expect(rpcClient({ data: null, error: { code: 'PT409', message: 'SNAPSHOT_NOT_APPROVED' } }).repo.activateEndpoint(ORG, EP))
      .rejects.toBeInstanceOf(ActivationDeniedError);
  });
  it('PT409 with another message is NOT treated as a snapshot refusal -> DatabaseTimeoutError', async () => {
    await expect(rpcClient({ data: null, error: { code: 'PT409', message: 'SOMETHING_ELSE' } }).repo.activateEndpoint(ORG, EP))
      .rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
  it('42501 -> RepoError(42501)', async () => {
    const err = await rpcClient({ data: null, error: { code: '42501', message: 'FORBIDDEN' } }).repo.activateEndpoint(ORG, EP).catch((e) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).pgCode).toBe('42501');
  });
  it.each([
    ['lock timeout', { code: '55P03', message: 'canceling statement due to lock timeout' }],
    ['statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['PostgREST unavailable', { code: 'PGRST000', message: 'Could not connect' }],
    ['our fetch timeout (no SQLSTATE)', { code: '', message: 'TimeoutError: The operation was aborted due to timeout' }],
  ])('%s -> DatabaseTimeoutError (never "not approved", never success)', async (_l, error) => {
    await expect(rpcClient({ data: null, error }).repo.activateEndpoint(ORG, EP)).rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
});

describe('route mapping for the activation outcomes', () => {
  it('ActivationDeniedError -> 409 ACTIVATION_DENIED, no-store', async () => {
    const res = endpointLookupFailure(new ActivationDeniedError())!;
    expect(res.status).toBe(409);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).error.code).toBe('ACTIVATION_DENIED');
  });
  it('EndpointNotFoundError -> 404 NOT_FOUND', async () => {
    const res = endpointLookupFailure(new EndpointNotFoundError())!;
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});
