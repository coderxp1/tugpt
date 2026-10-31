// Operator-only access, separate from tenant auth. Fail closed in EVERY environment.
// The local launcher generates a random key and binds Next to loopback.
import { createHash, createHmac, timingSafeEqual as equal } from 'node:crypto';

export const CONTROL_CENTER_COOKIE = 'tugpt_control_center';
export const CONTROL_CENTER_HEADER = 'x-control-center-key';
export const CONTROL_CENTER_MIN_TOKEN_LENGTH = 24;
export const CONTROL_CENTER_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
export type OperatorAccessMode = 'token' | 'disabled';

export function resolveAccessMode(nodeEnv: string | undefined, configuredToken: string | undefined) {
  void nodeEnv; // Development is not an authorization boundary.
  const value = (configuredToken ?? '').trim();
  const weakToken = value.length > 0 && value.length < CONTROL_CENTER_MIN_TOKEN_LENGTH;
  const token = value.length >= CONTROL_CENTER_MIN_TOKEN_LENGTH ? value : null;
  return { mode: token ? 'token' as const : 'disabled' as const, token, weakToken };
}

export function timingSafeEqual(a: string, b: string): boolean {
  return equal(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// Signed, server-expiring bearer session. Rotating the owner key revokes all sessions.
export async function cookieValueFor(token: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + CONTROL_CENTER_COOKIE_MAX_AGE_SECONDS;
  const signature = createHmac('sha256', token).update(`control-center:v1:${expires}`).digest('hex');
  return `${expires}.${signature}`;
}

export function validCookie(value: string, token: string, now = Date.now()): boolean {
  if (!/^\d{10}\.[a-f0-9]{64}$/.test(value)) return false;
  const [expiry, signature] = value.split('.');
  const expires = Number(expiry);
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds || expires > seconds + CONTROL_CENTER_COOKIE_MAX_AGE_SECONDS) return false;
  const expected = createHmac('sha256', token).update(`control-center:v1:${expires}`).digest('hex');
  return timingSafeEqual(signature!, expected);
}

export type OperatorDecision =
  | { kind: 'allow'; via: 'cookie' | 'header' }
  | { kind: 'deny'; status: 401 | 404; reason: string };

export function decideOperatorAccess(evidence: {
  nodeEnv: string | undefined;
  configuredToken: string | undefined;
  cookieValue?: string;
  headerValue?: string;
}): OperatorDecision {
  const { token } = resolveAccessMode(evidence.nodeEnv, evidence.configuredToken);
  if (!token) return { kind: 'deny', status: 404, reason: 'Not Found' };
  if (evidence.headerValue !== undefined && timingSafeEqual(evidence.headerValue, token)) {
    return { kind: 'allow', via: 'header' };
  }
  if (evidence.cookieValue && validCookie(evidence.cookieValue, token)) {
    return { kind: 'allow', via: 'cookie' };
  }
  return { kind: 'deny', status: 401, reason: 'Owner access required. Open /control-center to unlock.' };
}
