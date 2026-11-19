/** Configure the public origin behind a reverse proxy; never trust forwarded headers. */
export function applicationOrigin(_request?: Request): string {
  const configured = process.env.TUGPT_APP_ORIGIN;
  if (!configured) throw new Error('Application origin is not configured');
  const origin = new URL(configured);
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || configured !== origin.origin) {
    throw new Error('Application origin must be an explicit HTTPS origin');
  }
  return origin.origin;
}
/** Browser mutations require same-origin JSON and a non-simple request header. */
export function isSameOriginMutation(request: Request): boolean {
  try {
    return request.headers.get('origin') === applicationOrigin(request) &&
      request.headers.get('x-tugpt-csrf') === '1' &&
      request.headers.get('sec-fetch-site') !== 'cross-site' &&
      request.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
  } catch { return false; }
}

/**
 * Standard CSRF/origin rejection for a state-changing route handler.
 * Returns a 403 JSON response when the request is not a same-origin JSON
 * mutation, otherwise null. Call it as the first statement of every
 * POST/PUT/PATCH/DELETE handler (enforced by mutation-origin-coverage.test.ts).
 * Never redirects and never reveals which check failed.
 */
export function crossOriginMutationResponse(request: Request): Response | null {
  if (isSameOriginMutation(request)) return null;
  return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Invalid origin' } }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Origin guard for a state-changing endpoint submitted by a plain HTML form,
 * which cannot set custom headers. Requires an exact same-origin `Origin`
 * header (always sent by browsers on cross-site POSTs); a missing Origin is
 * rejected. Returns a 403 JSON response on failure, otherwise null.
 */
export function crossOriginFormResponse(request: Request): Response | null {
  let ok = false;
  try {
    ok = request.headers.get('origin') === applicationOrigin(request) &&
      request.headers.get('sec-fetch-site') !== 'cross-site';
  } catch { ok = false; }
  if (ok) return null;
  return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Invalid origin' } }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function readSmallJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('Invalid request');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error('Request too large');
      parts.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { buffer.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } finally { await reader.cancel().catch(() => {}); }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Strict JSON object shape; business value/role validation stays in its route/RPC. */
export async function readJsonRecord(request: Request, allowedFields: readonly string[]): Promise<Record<string, unknown>> {
  const body = await readSmallJson(request);
  if (!isRecord(body) || Object.keys(body).some(key => !allowedFields.includes(key))) {
    throw new Error('Unexpected request fields');
  }
  return body;
}
