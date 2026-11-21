/**
 * Unit tests (no database) for addDocument's retry contract (Q-8). The real
 * races are exercised against PostgREST + RLS in workspace-api.integration.test.ts
 * and workspace_document_dedupe.test.sql; this pins the control flow.
 */
import { describe, expect, it } from 'vitest';
import type { DbResult, WorkspaceDb } from './db';
import { WorkspaceError } from './errors';
import { ADD_DOCUMENT_ATTEMPTS, addDocument, deleteCollection, removeDocument, updateCollection } from './library';

const ORG = 'a0000000-0000-4000-8000-000000000000';
const ME = 'a0000000-0000-4000-8000-0000000000a1';
const COL = 'c0000000-0000-4000-8000-000000000001';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
const fileRow = { id: FILE, owner_user_id: ME, filename: 'a.md', media_type: 'text/markdown', size_bytes: 3, sha256: SHA, visibility: 'private', status: 'ready', created_at: 't', updated_at: 't' };
const docRow = (id: string) => ({ id, collection_id: COL, file_id: FILE, title: 'a.md', status: 'pending', error_code: null, chunk_count: 0, indexed_at: null, created_at: 't', processing_attempts: 0, next_attempt_at: null });
const conflict: DbResult = { data: null, error: { code: '23505', message: 'duplicate key' } } as DbResult;
const none: DbResult = { data: null, error: null } as DbResult;
const okRow = (row: unknown): DbResult => ({ data: row, error: null }) as DbResult;

/** Chainable fake: every query ends in single()/maybeSingle(); answers come from a script in call order. */
function scriptedDb(script: DbResult[]) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      let op = 'select';
      const q = {
        select: () => q, eq: () => q,
        insert: () => { op = 'insert'; return q; },
        single: async () => { calls.push(`${table}.${op}`); return script.shift() ?? none; },
        maybeSingle: async () => { calls.push(`${table}.${op}`); return script.shift() ?? none; },
      };
      return q;
    },
  } as unknown as WorkspaceDb;
  return { db, calls };
}

describe('addDocument retry contract (Q-8)', () => {
  it('a new document is created: 202 path, created=true', async () => {
    const { db } = scriptedDb([okRow(fileRow), okRow(docRow('d1'))]);
    const r = await addDocument(db, ORG, ME, COL, { fileId: FILE });
    expect(r).toMatchObject({ created: true, document: { id: 'd1', status: 'pending' } });
  });
  it('a duplicate returns the existing document unchanged with created=false (lost response, re-upload)', async () => {
    const { db, calls } = scriptedDb([okRow(fileRow), conflict, okRow(docRow('d-existing'))]);
    const r = await addDocument(db, ORG, ME, COL, { fileId: FILE });
    expect(r).toEqual({ created: false, document: expect.objectContaining({ id: 'd-existing', collectionId: COL, fileId: FILE, title: 'a.md' }) });
    expect(calls).toEqual(['workspace_files.select', 'knowledge_documents.insert', 'knowledge_documents.select']);
  });
  it('falls back to the content key when the file id is new', async () => {
    const { db } = scriptedDb([okRow(fileRow), conflict, none, okRow(docRow('d-same-bytes'))]);
    expect((await addDocument(db, ORG, ME, COL, { fileId: FILE })).document.id).toBe('d-same-bytes');
  });
  it('retries the insert once when the conflicting document was deleted in between', async () => {
    const { db, calls } = scriptedDb([okRow(fileRow), conflict, none, none, okRow(docRow('d-new'))]);
    const r = await addDocument(db, ORG, ME, COL, { fileId: FILE });
    expect(r).toMatchObject({ created: true, document: { id: 'd-new' } });
    expect(calls.filter((c) => c === 'knowledge_documents.insert')).toHaveLength(2);
  });
  it(`gives up with 409 ALREADY_EXISTS only after ${ADD_DOCUMENT_ATTEMPTS} vanishing conflicts`, async () => {
    const { db, calls } = scriptedDb([okRow(fileRow), conflict, none, none, conflict, none, none]);
    const e = await addDocument(db, ORG, ME, COL, { fileId: FILE }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WorkspaceError);
    expect([(e as WorkspaceError).status, (e as WorkspaceError).code]).toEqual([409, 'ALREADY_EXISTS']);
    expect(calls.filter((c) => c === 'knowledge_documents.insert')).toHaveLength(ADD_DOCUMENT_ATTEMPTS);
  });
  it('a file that is not ready is refused before any insert (409 CONFLICT)', async () => {
    const { db, calls } = scriptedDb([okRow({ ...fileRow, status: 'uploading' })]);
    const e = await addDocument(db, ORG, ME, COL, { fileId: FILE }).catch((x: unknown) => x);
    expect([(e as WorkspaceError).status, (e as WorkspaceError).code]).toEqual([409, 'CONFLICT']);
    expect(calls).toEqual(['workspace_files.select']);
  });
});

/**
 * Q-14: writes RLS let touch no row. Fake where delete()/update() resolve to the scripted
 * row list (awaitable or via maybeSingle) and select()...maybeSingle() answers visibility.
 */
function writeDb(affected: unknown[], visible: unknown) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      let op = 'select';
      const answer = () => (op === 'select' ? { data: visible, error: null } : { data: op === 'update' ? (affected[0] ?? null) : affected, error: null });
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q,
        delete: () => { op = 'delete'; return q; },
        update: () => { op = 'update'; return q; },
        maybeSingle: async () => { calls.push(`${table}.${op}`); return answer(); },
        then: (res: (v: unknown) => unknown) => { calls.push(`${table}.${op}`); return Promise.resolve(answer()).then(res); },
      };
      return q;
    },
  } as unknown as WorkspaceDb;
  return { db, calls };
}
const statusOf = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x: unknown) => x); return e instanceof WorkspaceError ? [e.status, e.code] : 'ok'; };
const DOC = 'd0000000-0000-4000-8000-000000000001';

describe('remove / rename / delete refusals: 403 vs 404 (Q-14)', () => {
  it('removeDocument: removed -> ok; readable but not writable -> 403 FORBIDDEN; gone or invisible -> 404 NOT_FOUND', async () => {
    expect(await statusOf(removeDocument(writeDb([{ id: DOC }], null).db, ORG, COL, DOC))).toBe('ok');
    const forbidden = writeDb([], { id: DOC });
    expect(await statusOf(removeDocument(forbidden.db, ORG, COL, DOC))).toEqual([403, 'FORBIDDEN']);
    expect(forbidden.calls).toEqual(['knowledge_documents.delete', 'knowledge_documents.select']);
    expect(await statusOf(removeDocument(writeDb([], null).db, ORG, COL, DOC))).toEqual([404, 'NOT_FOUND']);
  });
  it('updateCollection: readable but not writable -> 403; invisible -> 404', async () => {
    expect(await statusOf(updateCollection(writeDb([], { id: COL }).db, ORG, ME, COL, { name: 'x' }))).toEqual([403, 'FORBIDDEN']);
    expect(await statusOf(updateCollection(writeDb([], null).db, ORG, ME, COL, { name: 'x' }))).toEqual([404, 'NOT_FOUND']);
  });
  it('deleteCollection keeps the same rule', async () => {
    expect(await statusOf(deleteCollection(writeDb([], { id: COL }).db, ORG, COL))).toEqual([403, 'FORBIDDEN']);
    expect(await statusOf(deleteCollection(writeDb([], null).db, ORG, COL))).toEqual([404, 'NOT_FOUND']);
    expect(await statusOf(deleteCollection(writeDb([{ id: COL }], null).db, ORG, COL))).toBe('ok');
  });
});
