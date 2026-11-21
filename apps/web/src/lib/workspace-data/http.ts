/**
 * Request plumbing shared by the Workspace routes.
 *
 * Authentication and tenant resolution are NOT reimplemented: workspaceContext
 * delegates to lib/chat/request.chatContext (session user, strict tenant
 * resolution, RLS-bound client), so the Workspace API and chat API can never
 * disagree about who the caller is or which organization they act in.
 */
import { NextResponse } from 'next/server';
import { chatContext, PRIVATE_HEADERS } from '@/lib/chat/request';
import { applicationOrigin, readJsonRecord } from '@/lib/http/mutations';
import type { TenantContext } from '@tugpt/auth';
import { asWorkspaceDb, type WorkspaceDb } from './db';
import { WorkspaceError, type WorkspaceErrorCode } from './errors';

export interface WorkspaceContext {
  readonly db: WorkspaceDb;
  readonly userId: string;
  readonly organizationId: string;
  readonly tenant: TenantContext;
}

export async function workspaceContext(request: Request): Promise<WorkspaceContext | NextResponse> {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  return { db: asWorkspaceDb(ctx.db), userId: ctx.userId, organizationId: ctx.tenant.organizationId, tenant: ctx.tenant };
}

export function errorResponse(status: number, code: WorkspaceErrorCode, retryAfterSeconds?: number): NextResponse {
  const headers: Record<string, string> = { ...PRIVATE_HEADERS };
  if ((status === 429 || status === 409) && retryAfterSeconds !== undefined) headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  return NextResponse.json(retryAfterSeconds !== undefined ? { error: code, retryAfterSeconds } : { error: code }, { status, headers });
}

/** Map any thrown value to a response. Unknown errors become 503 without detail. */
export function toErrorResponse(e: unknown): NextResponse {
  if (e instanceof WorkspaceError) return errorResponse(e.status, e.code, e.retryAfterSeconds);
  return errorResponse(503, 'STORE_UNAVAILABLE');
}

export function ok(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

/**
 * CSRF guard for state-changing requests that carry no JSON body (DELETE,
 * raw-body upload): exact configured origin, the non-simple x-tugpt-csrf
 * header (forces a CORS preflight that our origin never grants), and no
 * cross-site fetch metadata.
 */
export function isSameOriginRequest(request: Request): boolean {
  try {
    return request.headers.get('origin') === applicationOrigin(request) &&
      request.headers.get('x-tugpt-csrf') === '1' &&
      request.headers.get('sec-fetch-site') !== 'cross-site';
  } catch { return false; }
}

/** Same-origin JSON mutation: CSRF guard + application/json + strict field allowlist (16 KB). */
export async function readMutation(request: Request, fields: readonly string[]): Promise<Record<string, unknown> | NextResponse> {
  if (!isSameOriginRequest(request) || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    return errorResponse(403, 'INVALID_ORIGIN');
  }
  try { return await readJsonRecord(request, fields); } catch { return errorResponse(400, 'INVALID_REQUEST'); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function parseLimit(v: string | null, fallback: number, max: number): number {
  if (v === null) return fallback;
  if (!/^\d{1,4}$/.test(v)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return Math.min(Math.max(Number(v), 1), max);
}
export function parseCursor(v: string | null): string | null {
  if (v === null) return null;
  const t = Date.parse(v);
  if (v.length > 40 || Number.isNaN(t)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return new Date(t).toISOString();
}
export function parseBool(v: string | null): boolean {
  if (v === null || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  throw new WorkspaceError(400, 'INVALID_REQUEST');
}

/** Single-line, trimmed, NFC user text without control characters. */
export function cleanName(v: unknown, max: number): string {
  if (typeof v !== 'string') throw new WorkspaceError(400, 'INVALID_REQUEST');
  const s = v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || Array.from(s).length > max) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return s;
}
export function optionalText(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new WorkspaceError(400, 'INVALID_REQUEST');
  const s = v.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (Array.from(s).length > max) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return s || null;
}
