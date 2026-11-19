/**
 * @file workspace-rpc.ts
 * @description Minimal RPC surface the workspace workers need. supabase-js
 * clients satisfy it structurally; tests pass a fake. Errors are reduced to
 * the database's message code (e.g. LEASE_LOST) so nothing else from the
 * response (which could contain row data) reaches logs.
 */

export interface RpcResult { readonly data: unknown; readonly error: { readonly message?: string; readonly code?: string } | null }
export interface RpcClient { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> }

export class RpcError extends Error {
  constructor(readonly fn: string, readonly code: string) { super(`${fn}: ${code}`); this.name = 'RpcError'; }
}

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export async function callRpc<T>(db: RpcClient, fn: string, args: Record<string, unknown>): Promise<T> {
  let res: RpcResult;
  try { res = await db.rpc(fn, args); } catch { throw new RpcError(fn, 'DB_UNAVAILABLE'); }
  if (res.error) {
    const m = typeof res.error.message === 'string' && CODE.test(res.error.message) ? res.error.message : 'DB_ERROR';
    throw new RpcError(fn, m);
  }
  return res.data as T;
}
