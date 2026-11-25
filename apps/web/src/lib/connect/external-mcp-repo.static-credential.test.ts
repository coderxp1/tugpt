/**
 * The static-credential repository methods (Plan A1): RPC names/arguments and
 * the SQLSTATE -> typed-error mapping for begin/complete/fail/get. The client
 * is a labelled stand-in for supabase-js `rpc`, following the pattern of
 * external-mcp-repo.test.ts; database behaviour itself is covered by the
 * pgTAP suite (mcp_static_credential_admin.test.sql).
 */
import { describe, expect, it } from 'vitest';
import {
  AuthAlreadyAttachedError,
  createExternalMcpRepository,
  EndpointNotFoundError,
  RepoError,
} from './external-mcp-repo';

function clientReturning(result: { data?: unknown; error?: { code: string; message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
  return { client, calls };
}

const ORG = '00000000-0000-4000-8000-000000000001';
const EP = '00000000-0000-4000-8000-000000000002';
const CONN = '00000000-0000-4000-8000-000000000003';

describe('beginStaticCredential', () => {
  it('returns the new connection id and calls the begin RPC', async () => {
    const { client, calls } = clientReturning({ data: CONN });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.beginStaticCredential(ORG, EP)).resolves.toBe(CONN);
    expect(calls).toEqual([
      { fn: 'begin_mcp_static_credential', args: { p_organization_id: ORG, p_endpoint_id: EP } },
    ]);
  });

  it('maps PT409 to AuthAlreadyAttachedError', async () => {
    const { client } = clientReturning({ error: { code: 'PT409', message: 'MCP_AUTH_ALREADY_ATTACHED' } });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.beginStaticCredential(ORG, EP)).rejects.toBeInstanceOf(AuthAlreadyAttachedError);
  });

  it('maps P0002 to EndpointNotFoundError', async () => {
    const { client } = clientReturning({ error: { code: 'P0002', message: 'MCP endpoint not found' } });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.beginStaticCredential(ORG, EP)).rejects.toBeInstanceOf(EndpointNotFoundError);
  });

  it('maps 42501 to RepoError (role refusal is not a timeout)', async () => {
    const { client } = clientReturning({ error: { code: '42501', message: 'FORBIDDEN' } });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.beginStaticCredential(ORG, EP)).rejects.toBeInstanceOf(RepoError);
  });
});

describe('completeStaticCredential / failStaticCredential', () => {
  it('complete returns the RPC boolean', async () => {
    const { client, calls } = clientReturning({ data: true });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.completeStaticCredential(ORG, CONN)).resolves.toBe(true);
    expect(calls[0].fn).toBe('complete_mcp_static_credential');
  });

  it('fail returns the RPC boolean and passes endpoint + connection', async () => {
    const { client, calls } = clientReturning({ data: false });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.failStaticCredential(ORG, EP, CONN)).resolves.toBe(false);
    expect(calls).toEqual([
      {
        fn: 'fail_mcp_static_credential',
        args: { p_organization_id: ORG, p_endpoint_id: EP, p_connection_id: CONN },
      },
    ]);
  });
});

describe('getEndpointAuthConnection', () => {
  it('returns the attached connection id', async () => {
    const { client } = clientReturning({ data: CONN });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.getEndpointAuthConnection(ORG, EP)).resolves.toBe(CONN);
  });

  it('returns null for a public endpoint (no credential attached)', async () => {
    const { client } = clientReturning({ data: null });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.getEndpointAuthConnection(ORG, EP)).resolves.toBeNull();
  });

  it('maps P0002 to EndpointNotFoundError', async () => {
    const { client } = clientReturning({ error: { code: 'P0002', message: 'MCP endpoint not found' } });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.getEndpointAuthConnection(ORG, EP)).rejects.toBeInstanceOf(EndpointNotFoundError);
  });
});
