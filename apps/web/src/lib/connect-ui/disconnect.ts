import { createTranslator, type Translator } from '@/i18n';
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

const EN = createTranslator('en');
/** What the person reads after a disconnect attempt; the shown status always comes from a fresh read. */
export function disconnectText(outcome: DisconnectOutcome, provider: string, t: Translator = EN): string {
  return t(`connect.disconnect.${outcome}`, { provider });
}
export const DISCONNECT_TEXT: Record<DisconnectOutcome, (name: string) => string> = {
  revoked: (n) => disconnectText('revoked', n), failed: (n) => disconnectText('failed', n), unknown: (n) => disconnectText('unknown', n),
};
