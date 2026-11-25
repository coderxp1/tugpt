/**
 * Service-to-service request authentication for the credential broker.
 *
 * signature = HMAC-SHA256(callerKey, METHOD ␟ PATH ␟ TIMESTAMP ␟ NONCE ␟ sha256hex(body))
 *
 * Caller keys authenticate; they cannot decrypt anything (separation of
 * application credentials from encryption keys). Each caller may have two
 * active keys during rotation.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CALLERS = ['web', 'worker', 'executor'] as const;
export type Caller = (typeof CALLERS)[number];

export const HEADER_CALLER = 'x-tugpt-caller';
export const HEADER_TIMESTAMP = 'x-tugpt-timestamp';
export const HEADER_NONCE = 'x-tugpt-nonce';
export const HEADER_SIGNATURE = 'x-tugpt-signature';

const SEP = '\u001f';
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface SignedHeaders {
  readonly [HEADER_CALLER]: Caller;
  readonly [HEADER_TIMESTAMP]: string;
  readonly [HEADER_NONCE]: string;
  readonly [HEADER_SIGNATURE]: string;
}

function canonical(method: string, path: string, ts: string, nonce: string, body: string): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return [method.toUpperCase(), path, ts, nonce, bodyHash].join(SEP);
}

export function signRequest(input: {
  caller: Caller;
  key: Buffer;
  method: string;
  path: string;
  body: string;
  now?: number;
  nonce?: string;
}): SignedHeaders {
  const ts = String(Math.floor((input.now ?? Date.now()) / 1000));
  const nonce = input.nonce ?? randomBytes(18).toString('base64url');
  const sig = createHmac('sha256', input.key).update(canonical(input.method, input.path, ts, nonce, input.body)).digest('hex');
  return {
    [HEADER_CALLER]: input.caller,
    [HEADER_TIMESTAMP]: ts,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: sig,
  };
}

/** Single-use nonces within the skew window. In-memory: the broker is a single instance. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}
  /** Returns false if the nonce was already used. */
  useOnce(nonce: string, now: number): boolean {
    for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

export type VerifyFailure = 'MISSING_HEADERS' | 'UNKNOWN_CALLER' | 'STALE' | 'BAD_SIGNATURE' | 'REPLAY';
export type VerifyResult = { ok: true; caller: Caller } | { ok: false; reason: VerifyFailure };

export function verifyRequest(input: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  method: string;
  path: string;
  body: string;
  callerKeys: ReadonlyMap<Caller, readonly Buffer[]>;
  nonces: NonceCache;
  now?: number;
  maxSkewSeconds?: number;
}): VerifyResult {
  const h = (k: string) => {
    const v = input.headers[k];
    return typeof v === 'string' ? v : undefined;
  };
  const caller = h(HEADER_CALLER);
  const ts = h(HEADER_TIMESTAMP);
  const nonce = h(HEADER_NONCE);
  const sig = h(HEADER_SIGNATURE);
  if (!caller || !ts || !nonce || !sig || !/^\d{1,12}$/.test(ts) || !NONCE_RE.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
    return { ok: false, reason: 'MISSING_HEADERS' };
  }
  const keys = (CALLERS as readonly string[]).includes(caller) ? input.callerKeys.get(caller as Caller) : undefined;
  if (!keys || keys.length === 0) return { ok: false, reason: 'UNKNOWN_CALLER' };

  const now = input.now ?? Date.now();
  const skew = input.maxSkewSeconds ?? 60;
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > skew) return { ok: false, reason: 'STALE' };

  const msg = canonical(input.method, input.path, ts, nonce, input.body);
  const given = Buffer.from(sig, 'hex');
  // Check every key (no early exit) so timing does not reveal which key matched.
  let match = false;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(msg).digest();
    if (expected.length === given.length && timingSafeEqual(expected, given)) match = true;
  }
  if (!match) return { ok: false, reason: 'BAD_SIGNATURE' };
  // Nonce is consumed only after a valid signature, so an attacker cannot burn nonces.
  if (!input.nonces.useOnce(`${caller}:${nonce}`, now)) return { ok: false, reason: 'REPLAY' };
  return { ok: true, caller: caller as Caller };
}
