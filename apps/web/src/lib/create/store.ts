/**
 * Image generation history through the caller's own RLS-bound client
 * (supabase/migrations/20261115000002_create_images.sql). No service role:
 * a user reads and updates exactly their own rows in their current organization.
 */
import type { ChatDb, DbResult } from '@/lib/chat/store';
import { ChatStoreError } from '@/lib/chat/store';

export type ImageStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';
const STATUSES: readonly ImageStatus[] = ['queued', 'processing', 'completed', 'failed', 'cancelled', 'expired'];
export const isTerminal = (s: ImageStatus) => s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'expired';

export interface ImageGeneration {
  readonly id: string; readonly prompt: string; readonly width: number; readonly height: number;
  readonly seed: number; readonly modelKey: string; readonly status: ImageStatus; readonly progress: number;
  readonly errorCode: string | null; readonly seconds: number | null;
  readonly createdAt: string; readonly finishedAt: string | null;
}

const COLUMNS = 'id,prompt,width,height,seed,model_key,status,progress,error_code,seconds,created_at,finished_at';

function check(r: DbResult): unknown {
  if (r.error) throw new ChatStoreError(r.error.code === '42501' ? 'FORBIDDEN' : 'STORE_UNAVAILABLE');
  return r.data;
}
const bad = (): never => { throw new ChatStoreError('STORE_UNAVAILABLE'); };
const str = (v: unknown): string => (typeof v === 'string' ? v : bad());
const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : bad());
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : bad();
};

export function toGeneration(row: unknown): ImageGeneration {
  const r = (row ?? bad()) as Record<string, unknown>;
  const status = str(r.status) as ImageStatus;
  if (!STATUSES.includes(status)) bad();
  return {
    id: str(r.id), prompt: str(r.prompt), width: int(r.width), height: int(r.height), seed: int(r.seed),
    modelKey: str(r.model_key), status, progress: int(r.progress),
    errorCode: r.error_code === null || r.error_code === undefined ? null : str(r.error_code),
    seconds: num(r.seconds), createdAt: str(r.created_at),
    finishedAt: r.finished_at === null || r.finished_at === undefined ? null : str(r.finished_at),
  };
}

export async function listGenerations(db: ChatDb, organizationId: string, userId: string, limit = 24): Promise<ImageGeneration[]> {
  const data = check(await db.from('image_generations').select(COLUMNS)
    .eq('organization_id', organizationId).eq('owner_user_id', userId)
    .order('created_at', { ascending: false }).limit(limit));
  return Array.isArray(data) ? data.map(toGeneration) : bad();
}

export async function getGeneration(db: ChatDb, organizationId: string, userId: string, id: string): Promise<ImageGeneration | null> {
  const data = check(await db.from('image_generations').select(COLUMNS)
    .eq('id', id).eq('organization_id', organizationId).eq('owner_user_id', userId).maybeSingle());
  return data ? toGeneration(data) : null;
}

export interface NewGeneration {
  readonly id: string; readonly organizationId: string; readonly userId: string; readonly prompt: string;
  readonly width: number; readonly height: number; readonly seed: number; readonly modelKey: string;
  readonly status: ImageStatus; readonly progress: number;
}

export async function insertGeneration(db: ChatDb, g: NewGeneration): Promise<ImageGeneration> {
  const data = check(await db.from('image_generations').insert({
    id: g.id, organization_id: g.organizationId, owner_user_id: g.userId, prompt: g.prompt,
    width: g.width, height: g.height, seed: g.seed, model_key: g.modelKey, status: g.status, progress: g.progress,
  }).select(COLUMNS).single());
  return toGeneration(data);
}

export interface StatusPatch {
  readonly status: ImageStatus; readonly progress: number;
  readonly errorCode: string | null; readonly seconds: number | null;
}

export async function recordStatus(db: ChatDb, organizationId: string, userId: string, id: string, p: StatusPatch): Promise<ImageGeneration> {
  const data = check(await db.from('image_generations').update({
    status: p.status, progress: p.progress, error_code: p.errorCode,
    seconds: p.seconds === null ? null : Math.round(p.seconds * 100) / 100,
    finished_at: isTerminal(p.status) ? new Date().toISOString() : null,
  }).eq('id', id).eq('organization_id', organizationId).eq('owner_user_id', userId).select(COLUMNS).single());
  return toGeneration(data);
}
