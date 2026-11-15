/**
 * Disconnect a provider through the Connect v2 route (B-5).
 *
 * The route answers with a redirect to /settings/integrations?{provider}=revoked
 * or ?{provider}=error&reason=disconnect_failed. When the redirect stays on this
 * origin the outcome is read from the final URL. When it cannot be read (a
 * pinned public origin, a network error) the outcome is 'unknown' and the
 * caller must re-read the real status: nothing is ever assumed disconnected.
 */
import { DISCONNECT_PATH, parseOAuthReturn, type ConnectProvider } from './contract';
import { MUTATION_HEADERS } from './http';

export type DisconnectOutcome = 'revoked' | 'failed' | 'unknown';

export async function disconnectProvider(provider: ConnectProvider, fetcher: typeof fetch = fetch): Promise<DisconnectOutcome> {
  let res: Response;
  try {
    res = await fetcher(DISCONNECT_PATH[provider], { method: 'POST', headers: MUTATION_HEADERS, body: '{}', cache: 'no-store', redirect: 'follow' });
  } catch { return 'unknown'; }
  let params: URLSearchParams;
  try { params = new URL(res.url).searchParams; } catch { return res.ok ? 'unknown' : 'failed'; }
  const r = parseOAuthReturn(Object.fromEntries(params));
  if (r && r.provider === provider) {
    if (r.outcome === 'revoked') return 'revoked';
    if (r.outcome === 'error') return 'failed';
  }
  return res.ok ? 'unknown' : 'failed';
}

export const DISCONNECT_TEXT: Record<DisconnectOutcome, (name: string) => string> = {
  revoked: (n) => `${n} is disconnected.`,
  failed: (n) => `${n} could not be disconnected. It may still be connected; the status below was checked again.`,
  unknown: (n) => `TuGPT could not confirm whether ${n} was disconnected. The status below was checked again; trust that.`,
};
