import { describe, expect, it } from 'vitest';
import type { DbResult, WorkspaceDb, WsQuery } from './db';
import { decideUpload, findByUploadKey, insertUploading, parseIdempotencyKey, UPLOAD_IN_PROGRESS_WINDOW_MS, UPLOAD_RETRY_AFTER_SECONDS } from './files';

const KEY = '0f8b3c1e-6a2d-4c5b-9e7f-1a2b3c4d5e6f';
const NOW = Date.parse('2026-11-22T10:00:00Z');
const row = (o: Record<string, unknown>) => ({ id: 'f1', owner_user_id: 'u1', filename: 'a.txt', media_type: 'text/plain', size_bytes: 5, sha256: 'abc', visibility: 'private', status: 'ready', created_at: new Date(NOW - 1000).toISOString(), updated_at: new Date(NOW).toISOString(), ...o });

/** Answers each terminal call from `results` in order and records inserted values and filters. */
function fake(results: DbResult[]) {
  const inserts: Record<string, unknown>[] = []; const filters: Record<string, unknown>[] = [];
  const next = () => Promise.resolve(results.shift() ?? { data: null, error: null });
  const q = (f: Record<string, unknown>): WsQuery => {
    const self: WsQuery = {
      select: () => self, eq: (k, v) => { f[k] = v; return self; }, is: () => self, in: (k, v) => { f[k] = v; return self; }, lt: () => self,
      order: () => self, limit: () => self, single: next, maybeSingle: next, then: (ok, ko) => next().then(ok, ko),
    };
    return self;
  };
  const db: WorkspaceDb = {
    from: () => ({
      select: () => { const f = {}; filters.push(f); return q(f); },
      insert: (v) => { inserts.push(v as Record<string, unknown>); return q({}); },
      update: () => q({}), delete: () => q({}),
    }),
    rpc: () => next(),
  };
  return { db, inserts, filters };
}

describe('upload idempotency (Q-13)', () => {
  it('parses the Idempotency-Key header: absent -> null, UUID -> lower case, anything else -> 400', () => {
    expect(parseIdempotencyKey(null)).toBeNull();
    expect(parseIdempotencyKey(` ${KEY.toUpperCase()} `)).toBe(KEY);
    for (const bad of ['', 'abc', `${KEY}x`, '../etc']) expect(() => parseIdempotencyKey(bad)).toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_IDEMPOTENCY_KEY' }));
  });

  it('decides on content only: same bytes replay (even renamed), different bytes are a key reuse', () => {
    const c = { sha256: 'abc', sizeBytes: 5 };
    expect(decideUpload(null, c, NOW)).toEqual({ kind: 'fresh' });
    expect(decideUpload({ row: row({ filename: 'renamed.txt' }) }, c, NOW).kind).toBe('replay');
    expect(decideUpload({ row: row({ sha256: 'zzz' }) }, c, NOW)).toEqual({ kind: 'mismatch' });
    expect(decideUpload({ row: row({ size_bytes: 6 }) }, c, NOW)).toEqual({ kind: 'mismatch' });
  });

  it('a running upload is in progress with a short Retry-After; an abandoned one is replaced', () => {
    const c = { sha256: 'abc', sizeBytes: 5 };
    const young = decideUpload({ row: row({ status: 'uploading', sha256: null, created_at: new Date(NOW - 30_000).toISOString() }) }, c, NOW);
    expect(young).toEqual({ kind: 'in_progress', retryAfterSeconds: UPLOAD_RETRY_AFTER_SECONDS });
    expect(UPLOAD_RETRY_AFTER_SECONDS).toBeLessThanOrEqual(5); // a hint to retry soon, not the abandonment window
    const old = decideUpload({ row: row({ status: 'uploading', sha256: null, created_at: new Date(NOW - UPLOAD_IN_PROGRESS_WINDOW_MS - 1).toISOString() }) }, c, NOW);
    expect(old).toEqual({ kind: 'stale', fileId: 'f1' });
  });

  it('looks the key up for this organization and uploader only, ignoring failed uploads', async () => {
    const f = fake([{ data: row({}), error: null }]);
    expect(await findByUploadKey(f.db, 'o1', 'u1', KEY)).toEqual({ row: row({}) });
    expect(f.filters[0]).toEqual({ organization_id: 'o1', owner_user_id: 'u1', upload_request_id: KEY, status: ['uploading', 'ready'] });
  });

  it('pre-Q-13 schema: lookup reports unsupported and the insert drops the key (Q-12 behaviour)', async () => {
    expect(await findByUploadKey(fake([{ data: null, error: { code: '42703', message: 'column does not exist' } }]).db, 'o1', 'u1', KEY)).toBe('unsupported');
    const f = fake([{ data: null, error: { code: 'PGRST204', message: 'unknown column' } }, { data: { id: 'new' }, error: null }]);
    expect(await insertUploading(f.db, 'o1', 'u1', { filename: 'a.txt', mediaType: 'text/plain', sizeBytes: 5, visibility: 'private', uploadKey: KEY })).toBe('new');
    expect(f.inserts[0].upload_request_id).toBe(KEY);
    expect('upload_request_id' in f.inserts[1]).toBe(false);
  });

  it('a lost insert race is a conflict, not an error; other errors still fail closed', async () => {
    expect(await insertUploading(fake([{ data: null, error: { code: '23505', message: 'dup' } }]).db, 'o1', 'u1', { filename: 'a', mediaType: 'text/plain', sizeBytes: 1, visibility: 'private', uploadKey: KEY })).toBe('conflict');
    await expect(insertUploading(fake([{ data: null, error: { code: '42501', message: 'rls' } }]).db, 'o1', 'u1', { filename: 'a', mediaType: 'text/plain', sizeBytes: 1, visibility: 'private', uploadKey: KEY }))
      .rejects.toMatchObject({ status: 403 });
  });
});
