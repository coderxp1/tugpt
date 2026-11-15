/** Same-origin JSON mutation, the shape isSameOriginMutation() accepts. */
export const MUTATION_HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

/** POSTs JSON and normalises both error shapes in use: {error:{code,message}} (Connect) and {error:string} (proxy, chat). */
export async function postJson<T>(url: string, body: unknown = {}, fetcher: typeof fetch = fetch): Promise<ApiResult<T>> {
  let res: Response;
  try { res = await fetcher(url, { method: 'POST', headers: MUTATION_HEADERS, body: JSON.stringify(body), cache: 'no-store' }); }
  catch { return { ok: false, status: 0, code: 'NETWORK', message: 'TuGPT could not be reached.' }; }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: data as T };
  const err = (data as { error?: unknown } | null)?.error;
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    return { ok: false, status: res.status, code: typeof e.code === 'string' ? e.code : 'ERROR', message: typeof e.message === 'string' ? e.message : '' };
  }
  return { ok: false, status: res.status, code: typeof err === 'string' ? err : 'ERROR', message: '' };
}
