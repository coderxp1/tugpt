/**
 * Chat approvals for customer MCP tools that change something (B-11).
 *
 * Browser-safe. The server emits an `approval_required` event when the
 * runtime refused an MCP call with APPROVAL_REQUIRED; this module
 *   - parses that event strictly (anything malformed is dropped, never shown
 *     as approvable),
 *   - turns the call arguments into display lines with secrets redacted and
 *     long values truncated,
 *   - calls Agent 2's approval routes and reports success ONLY for the exact
 *     success shape on HTTP 200. Any other status, body, or a network error is
 *     a failure, and a failure is never treated as permission,
 *   - models the card's lifecycle as a pure reducer.
 *
 * The browser never decides that a call may run: the run route executes
 * through the Connect runtime, which atomically claims the approval in the
 * database (claim_tool_approval) for this exact endpoint, tool and
 * argument hash. Changed arguments, expiry, revocation or reuse all fail there.
 */
import { createTranslator } from '@/i18n';
import type { Translator } from '@/i18n/types';

export type ApprovalPermissionClass = 'write' | 'irreversible' | 'financial';

export interface PendingApproval {
  readonly callId: string;
  readonly threadId: string;
  readonly endpointId: string;
  readonly endpointName: string;
  readonly endpointHost: string;
  /** `external.<tool>` as stored for the endpoint's approved snapshot. */
  readonly capability: string;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly permissionClass: ApprovalPermissionClass;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** sha256 of the canonical JSON of `arguments`, computed by the server. */
  readonly argumentsSha256: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;
const CLASSES: readonly ApprovalPermissionClass[] = ['write', 'irreversible', 'financial'];

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The server's `approval` payload, or null if anything about it is off. */
export function parsePendingApproval(v: unknown): PendingApproval | null {
  if (!isPlainObject(v)) return null;
  const { callId, threadId, endpointId, endpointName, endpointHost, capability, toolName, toolDescription, permissionClass, argumentsSha256 } = v;
  const args = v.arguments;
  if (!str(callId, 128) || !CALL_ID.test(callId)) return null;
  if (!str(threadId, 36) || !UUID.test(threadId) || !str(endpointId, 36) || !UUID.test(endpointId)) return null;
  if (!str(endpointName, 200) || !str(endpointHost, 260) || !HOST.test(endpointHost)) return null;
  if (!str(toolName, 64) || !TOOL.test(toolName) || capability !== `external.${toolName}`) return null;
  if (typeof toolDescription !== 'string' || toolDescription.length > 2000) return null;
  if (!CLASSES.includes(permissionClass as ApprovalPermissionClass)) return null;
  if (typeof argumentsSha256 !== 'string' || !SHA256.test(argumentsSha256)) return null;
  if (!isPlainObject(args)) return null;
  return {
    callId, threadId, endpointId, endpointName, endpointHost, capability, toolName, toolDescription,
    permissionClass: permissionClass as ApprovalPermissionClass, arguments: args, argumentsSha256,
  };
}

// ------------------------------------------------------------------ display

/** Keys whose values are never shown. Matched against each path segment. */
const SECRET_KEY = /(token|secret|passw|pwd|passphrase|api[-_ ]?key|apikey|access[-_]?key|authori[sz]ation|^auth$|^auth[-_]|[-_]auth$|cookie|session|credential|private|signature|bearer|otp|pin$)/i;
/** Values that look like credentials even under an innocent key. */
const SECRET_VALUE = /^(bearer\s+\S+|basic\s+[A-Za-z0-9+/=]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export const DISPLAY_LIMITS = { maxDepth: 4, maxLines: 40, maxValue: 280 } as const;
export const REDACTED = 'Hidden';

export interface ArgumentLine {
  readonly path: string;
  readonly value: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

export interface ArgumentDisplay { readonly lines: readonly ArgumentLine[]; readonly omitted: number }

function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? String(v);
}

/** Flattens arguments into labelled lines; secrets are replaced, never copied into the output. */
export function displayArguments(args: Readonly<Record<string, unknown>>): ArgumentDisplay {
  const lines: ArgumentLine[] = [];
  let omitted = 0;
  const push = (line: ArgumentLine) => { if (lines.length < DISPLAY_LIMITS.maxLines) lines.push(line); else omitted += 1; };
  const walk = (v: unknown, path: string, depth: number, secret: boolean) => {
    if (secret) { push({ path, value: REDACTED, redacted: true, truncated: false }); return; }
    if (v !== null && typeof v === 'object') {
      const entries: [string, unknown][] = Array.isArray(v) ? v.map((x, i) => [`[${i}]`, x]) : Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) { push({ path, value: Array.isArray(v) ? '(empty list)' : '(empty)', redacted: false, truncated: false }); return; }
      if (depth >= DISPLAY_LIMITS.maxDepth) { push({ path, value: '(nested data not shown)', redacted: false, truncated: true }); return; }
      for (const [k, x] of entries) {
        const child = k.startsWith('[') ? `${path}${k}` : path ? `${path}.${k}` : k;
        walk(x, child, depth + 1, !k.startsWith('[') && SECRET_KEY.test(k));
      }
      return;
    }
    const text = scalar(v);
    if (SECRET_VALUE.test(text.trim())) { push({ path, value: REDACTED, redacted: true, truncated: false }); return; }
    const chars = Array.from(text);
    const truncated = chars.length > DISPLAY_LIMITS.maxValue;
    push({ path, value: truncated ? `${chars.slice(0, DISPLAY_LIMITS.maxValue).join('')}…` : text, redacted: false, truncated });
  };
  for (const [k, v] of Object.entries(args)) walk(v, k, 1, SECRET_KEY.test(k));
  return { lines, omitted };
}

const EN = createTranslator('en');

export const PERMISSION_TEXT: Record<ApprovalPermissionClass, { label: string; effect: string }> = {
  write: { label: 'Changes data', effect: 'This creates or changes data in the connected system.' },
  irreversible: { label: 'Cannot be undone', effect: 'This deletes or permanently changes data. It cannot be undone.' },
  financial: { label: 'Involves money', effect: 'This can create charges, payments or other financial transactions.' },
};

/** Approval lifetimes offered in the card. The backend accepts 1-3600 seconds. */
export const TTL_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
];

// --------------------------------------------------------------- API clients

export type ApprovalFailure = 'unauthenticated' | 'forbidden' | 'invalid' | 'not_found' | 'unavailable' | 'network' | 'unexpected';
export type ApprovalResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: ApprovalFailure; readonly status?: number; readonly code?: string };
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;
export const APPROVALS_URL = '/api/v1/connect/mcp/approvals';
export const APPROVAL_REQUESTS_URL = '/api/v1/connect/mcp/approvals/requests';
export const REVOKE_URL = '/api/v1/connect/mcp/approvals/revoke';
export const STATUS_URL = '/api/v1/chat/approvals/status';

function failureFor(status: number): ApprovalFailure {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 400 || status === 409 || status === 422) return 'invalid';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'unavailable';
  return 'unexpected';
}

async function body(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return undefined; }
}

function errorCode(b: unknown): string | undefined {
  const e = isPlainObject(b) ? b.error : undefined;
  if (typeof e === 'string') return e.slice(0, 80);
  const c = isPlainObject(e) ? e.code : undefined;
  return typeof c === 'string' ? c.slice(0, 80) : undefined;
}

async function call<T>(fetchFn: FetchFn, url: string, init: RequestInit, accept: (b: unknown) => T | undefined): Promise<ApprovalResult<T>> {
  let res: Response;
  try { res = await fetchFn(url, { ...init, cache: 'no-store', credentials: 'same-origin' }); } catch { return { ok: false, reason: 'network' }; }
  const b = await body(res);
  if (res.status !== 200) {
    const code = errorCode(b);
    return { ok: false, reason: failureFor(res.status), status: res.status, ...(code ? { code } : {}) };
  }
  const value = accept(b);
  return value === undefined ? { ok: false, reason: 'unexpected', status: res.status } : { ok: true, value };
}

const target = (p: PendingApproval) => ({ connectionId: p.endpointId, capability: p.capability, argumentsSha256: p.argumentsSha256 });

/** Agent 2's POST /api/v1/connect/mcp/approvals. Success only for HTTP 200 with {approved: true}. */
export async function requestApproval(p: PendingApproval, ttlSeconds: number, fetchFn: FetchFn = fetch): Promise<ApprovalResult<{ approved: true; id: string; expiresAt: number }>> {
  if (!TTL_OPTIONS.some((o) => o.seconds === ttlSeconds)) return { ok: false, reason: 'invalid' };
  return call(fetchFn, APPROVALS_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ ...target(p), threadId: p.threadId, ttlSeconds }) },
    (b) => (isPlainObject(b) && b.approved === true && typeof b.id === 'string' && typeof b.expiresAt === 'string'
      ? { approved: true as const, id: b.id, expiresAt: new Date(b.expiresAt).getTime() } : undefined));
}

/** A5 (R6): a member files an approval request for this exact blocked call. Idempotent per call + requester. */
export async function createApprovalRequest(p: PendingApproval, fetchFn: FetchFn = fetch): Promise<ApprovalResult<{ id: string; status: string }>> {
  return call(fetchFn, APPROVAL_REQUESTS_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ ...target(p), threadId: p.threadId }) },
    (b) => {
      const r = isPlainObject(b) ? b.request : undefined;
      return isPlainObject(r) && typeof r.id === 'string' && typeof r.status === 'string' ? { id: r.id, status: r.status } : undefined;
    });
}

/** Agent 2's POST /api/v1/connect/mcp/approvals/revoke. {revoked:false} means nothing unused was left to revoke. */
export async function revokeApproval(approvalId: string, fetchFn: FetchFn = fetch): Promise<ApprovalResult<{ revoked: boolean }>> {
  return call(fetchFn, REVOKE_URL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ approvalId }) },
    (b) => (isPlainObject(b) && typeof b.revoked === 'boolean' ? { revoked: b.revoked } : undefined));
}

/** is_tool_approved() through the chat status route: an unused, unexpired, unrevoked approval exists. */
export async function checkApproval(p: PendingApproval, fetchFn: FetchFn = fetch): Promise<ApprovalResult<{ approved: boolean }>> {
  const q = new URLSearchParams({ ...target(p), threadId: p.threadId });
  return call(fetchFn, `${STATUS_URL}?${q.toString()}`, { method: 'GET' },
    (b) => (isPlainObject(b) && typeof b.approved === 'boolean' ? { approved: b.approved } : undefined));
}

// ------------------------------------------------------------------- state

export type ApprovalState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'approving' }
  | { readonly kind: 'approved'; readonly id: string | null; readonly expiresAt: number | null }
  | { readonly kind: 'running'; readonly id: string | null; readonly expiresAt: number | null }
  | { readonly kind: 'done'; readonly ok: boolean; readonly code?: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'revoking'; readonly id: string | null; readonly expiresAt: number | null; readonly then: 'revoked' | 'rejected' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failed'; readonly reason: ApprovalFailure | 'not_recorded'; readonly code?: string };

export type ApprovalAction =
  | { readonly type: 'approve' }
  /** expiresAt null: the approval exists but its expiry is not known here (recorded by someone else). */
  | { readonly type: 'approved'; readonly id: string | null; readonly expiresAt: number | null }
  | { readonly type: 'approve_failed'; readonly reason: ApprovalFailure | 'not_recorded'; readonly code?: string }
  | { readonly type: 'reject' }
  | { readonly type: 'revoke'; readonly then?: 'revoked' | 'rejected' }
  | { readonly type: 'revoke_done' }
  | { readonly type: 'revoke_failed' }
  | { readonly type: 'expire' }
  | { readonly type: 'run' }
  | { readonly type: 'run_done'; readonly ok: boolean; readonly code?: string }
  /** The server refused the request before running anything: the approval was not claimed and stays usable. */
  | { readonly type: 'run_refused' };

export const INITIAL_APPROVAL: ApprovalState = { kind: 'pending' };

/** Pure transitions. Anything not listed is ignored, so a late response cannot resurrect a closed card. */
export function approvalReducer(s: ApprovalState, a: ApprovalAction): ApprovalState {
  switch (a.type) {
    case 'approve': return s.kind === 'pending' || s.kind === 'failed' ? { kind: 'approving' } : s;
    case 'approved': return s.kind === 'approving' ? { kind: 'approved', id: a.id, expiresAt: a.expiresAt } : s;
    case 'approve_failed': return s.kind === 'approving' ? { kind: 'failed', reason: a.reason, ...(a.code ? { code: a.code } : {}) } : s;
    case 'reject': return s.kind === 'pending' || s.kind === 'failed' ? { kind: 'rejected' } : s;
    case 'revoke': return s.kind === 'approved' ? { kind: 'revoking', id: s.id, expiresAt: s.expiresAt, then: a.then ?? 'revoked' } : s;
    case 'revoke_done': return s.kind === 'revoking' ? { kind: s.then } : s;
    // A failed revoke leaves the approval in place: say so by returning to approved.
    case 'revoke_failed': return s.kind === 'revoking' ? { kind: 'approved', id: s.id, expiresAt: s.expiresAt } : s;
    case 'expire': return s.kind === 'approved' ? { kind: 'expired' } : s;
    case 'run': return s.kind === 'approved' ? { kind: 'running', id: s.id, expiresAt: s.expiresAt } : s;
    case 'run_done': return s.kind === 'running' ? { kind: 'done', ok: a.ok, ...(a.code ? { code: a.code } : {}) } : s;
    case 'run_refused': return s.kind === 'running' ? { kind: 'approved', id: s.id, expiresAt: s.expiresAt } : s;
    default: return s;
  }
}

export function failureText(reason: ApprovalFailure | 'not_recorded', canApprove: boolean, t: Translator = EN): string {
  switch (reason) {
    case 'forbidden': return canApprove ? t('chat.fail.forbidden') : t('chat.fail.forbiddenOther');
    case 'unauthenticated': case 'invalid': case 'not_found': case 'unavailable': case 'network': case 'not_recorded':
      return t(`chat.fail.${reason}`);
    default: return t('chat.fail.unexpected');
  }
}

/** Permission badge and effect sentence in the reader's language. */
export function permissionText(cls: ApprovalPermissionClass, t: Translator = EN): { label: string; effect: string } {
  return { label: t(`chat.perm.${cls}.label`), effect: t(`chat.perm.${cls}.effect`) };
}
export const ttlLabel = (seconds: number, t: Translator = EN) => t.maybe(`chat.ttl.${seconds}`, `${seconds} s`);
