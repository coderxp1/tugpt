import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { blobKey, EmbeddingsClient, MemoryBlobStore, XLSX_MEDIA_TYPE, PDF_MEDIA_TYPE } from '@tugpt/workspace-core';
import { pdfExtractor } from '@tugpt/workspace-core/pdf';
import { makePdf, makeXlsx } from '../../../packages/workspace-core/src/fixtures.test-util';
import { processDocumentJob, runKnowledgeBatch, EMBEDDINGS_FALLBACK_ATTEMPT, type ClaimedDocumentJob, type KnowledgeLog } from '../src/knowledge-worker';
import type { RpcClient, RpcResult } from '../src/workspace-rpc';

const ORG = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Call = { fn: string; args: Record<string, unknown> };
function fakeDb(handlers: Record<string, (args: Record<string, unknown>) => RpcResult> = {}): RpcClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown> = {}) {
      calls.push({ fn, args });
      const h = handlers[fn];
      return Promise.resolve(h ? h(args) : { data: fn === 'fail_document_job' ? 'queued' : 1, error: null });
    },
  };
}
const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
const log: KnowledgeLog = {
  info: (message, context) => logs.push({ level: 'info', message, context }),
  warn: (message, context) => logs.push({ level: 'warn', message, context }),
  error: (message, context) => logs.push({ level: 'error', message, context }),
};
function job(bytes: Uint8Array, mediaType: string, over: Partial<ClaimedDocumentJob> = {}): ClaimedDocumentJob {
  return { document_id: DOC, organization_id: ORG, collection_id: ORG, file_id: FILE, media_type: mediaType, sha256: sha(bytes), size_bytes: bytes.length, attempt: 1, lease_token: '44444444-4444-4444-8444-444444444444', ...over };
}
async function storeWith(bytes: Uint8Array, mediaType: string) { const s = new MemoryBlobStore(); await s.put(blobKey(ORG, FILE), bytes, mediaType); return s; }
const enc = (t: string) => new TextEncoder().encode(t);
const completeArgs = (db: { calls: Call[] }) => db.calls.find((c) => c.fn === 'complete_document_job')?.args;

function fakeEmbeddings(dims: number, behaviour: 'ok' | 'down' = 'ok') {
  return new EmbeddingsClient({ baseUrl: 'http://127.0.0.1:1', model: 'test-embed', dims }, async (_u, init) => {
    if (behaviour === 'down') return new Response('nope', { status: 503 });
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    return Response.json({ data: input.map((_, i) => ({ index: i, embedding: Array.from({ length: dims }, (_, d) => (d === i % dims ? 1 : 0)) })) });
  });
}

describe('knowledge worker', () => {
  it('indexes a text file and stores chunks without embeddings when none are configured', async () => {
    const bytes = enc('Travel policy.\n\nHotels up to 150 EUR per night.');
    const db = fakeDb();
    const out = await processDocumentJob({ db, store: await storeWith(bytes, 'text/plain'), log }, job(bytes, 'text/plain'));
    expect(out).toEqual({ kind: 'ready', chunks: 1, embedded: false });
    const a = completeArgs(db)!;
    expect(a.p_status).toBe('ready');
    expect((a.p_chunks as string[])[0]).toContain('150 EUR');
    expect(a.p_embedding_model).toBeNull();
    expect(a.p_embeddings).toBeNull();
  });

  it('indexes XLSX and a real PDF (pdfjs) end to end', async () => {
    const xlsx = makeXlsx([['Budget', '<row r="1"><c r="A1" t="inlineStr"><is><t>Q3 travel budget</t></is></c><c r="B1"><v>4200</v></c></row>']]);
    const db1 = fakeDb();
    expect((await processDocumentJob({ db: db1, store: await storeWith(xlsx, XLSX_MEDIA_TYPE), log }, job(xlsx, XLSX_MEDIA_TYPE))).kind).toBe('ready');
    expect((completeArgs(db1)!.p_chunks as string[]).join(' ')).toMatch(/Q3 travel budget \| 4200/);

    const pdf = makePdf([['Quarterly security review'], ['Second page about badges']]);
    const db2 = fakeDb();
    const out = await processDocumentJob({ db: db2, store: await storeWith(pdf, PDF_MEDIA_TYPE), pdf: pdfExtractor, log }, job(pdf, PDF_MEDIA_TYPE));
    expect(out.kind).toBe('ready');
    const text = (completeArgs(db2)!.p_chunks as string[]).join(' ');
    expect(text).toContain('Quarterly security review');
    expect(text).toContain('Second page about badges');
  });

  it('stores one embedding per chunk as pgvector literals', async () => {
    const bytes = enc('Alpha section. '.repeat(200));
    const db = fakeDb();
    const out = await processDocumentJob({ db, store: await storeWith(bytes, 'text/plain'), embeddings: fakeEmbeddings(3), log }, job(bytes, 'text/plain'));
    expect(out.kind).toBe('ready');
    const a = completeArgs(db)!;
    expect(a.p_embedding_model).toBe('test-embed');
    expect((a.p_embeddings as string[]).length).toBe((a.p_chunks as string[]).length);
    expect((a.p_embeddings as string[])[0]).toMatch(/^\[[01],[01],[01]\]$/);
  });

  it('retries embedding outages early, then falls back to keyword-only', async () => {
    const bytes = enc('Some content to index.');
    const db1 = fakeDb();
    const early = await processDocumentJob({ db: db1, store: await storeWith(bytes, 'text/plain'), embeddings: fakeEmbeddings(3, 'down'), log }, job(bytes, 'text/plain', { attempt: 1 }));
    expect(early).toEqual({ kind: 'retry', code: 'EMBEDDINGS_UNAVAILABLE' });
    expect(db1.calls.find((c) => c.fn === 'fail_document_job')?.args.p_retryable).toBe(true);

    const db2 = fakeDb();
    const late = await processDocumentJob({ db: db2, store: await storeWith(bytes, 'text/plain'), embeddings: fakeEmbeddings(3, 'down'), log }, job(bytes, 'text/plain', { attempt: EMBEDDINGS_FALLBACK_ATTEMPT }));
    expect(late).toEqual({ kind: 'ready', chunks: 1, embedded: false });
    expect(logs.some((l) => l.message === 'knowledge.embeddings_fallback_keyword_only')).toBe(true);
  });

  it('treats storage errors as retryable and missing/corrupt files as final', async () => {
    const bytes = enc('hello world');
    const broken = new MemoryBlobStore(); broken.get = async () => { throw new Error('ECONNRESET secret-host'); };
    const db1 = fakeDb();
    expect(await processDocumentJob({ db: db1, store: broken, log }, job(bytes, 'text/plain'))).toEqual({ kind: 'retry', code: 'STORAGE_UNAVAILABLE' });

    const db2 = fakeDb();
    expect(await processDocumentJob({ db: db2, store: new MemoryBlobStore(), log }, job(bytes, 'text/plain'))).toEqual({ kind: 'failed', code: 'FILE_MISSING' });

    const db3 = fakeDb();
    expect(await processDocumentJob({ db: db3, store: await storeWith(bytes, 'text/plain'), log }, job(bytes, 'text/plain', { sha256: 'f'.repeat(64) })))
      .toEqual({ kind: 'failed', code: 'FILE_INTEGRITY_FAILED' });
    expect(completeArgs(db3)!.p_chunks).toEqual([]);
  });

  it('completes unsupported, encrypted-looking and empty documents with a code', async () => {
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const db1 = fakeDb();
    expect(await processDocumentJob({ db: db1, store: await storeWith(img, 'image/png'), log }, job(img, 'image/png'))).toEqual({ kind: 'unsupported', code: 'UNSUPPORTED_FOR_INDEXING' });
    const notPdf = enc('this is not a pdf');
    const db2 = fakeDb();
    const out = await processDocumentJob({ db: db2, store: await storeWith(notPdf, PDF_MEDIA_TYPE), pdf: pdfExtractor, log }, job(notPdf, PDF_MEDIA_TYPE));
    expect(out.kind).toBe('failed');
    const empty = enc('   \n  ');
    const db3 = fakeDb();
    expect(await processDocumentJob({ db: db3, store: await storeWith(empty, 'text/plain'), log }, job(empty, 'text/plain'))).toEqual({ kind: 'failed', code: 'EMPTY_DOCUMENT' });
  });

  it('drops the result when the lease was lost', async () => {
    const bytes = enc('content');
    const db = fakeDb({ complete_document_job: () => ({ data: null, error: { message: 'LEASE_LOST', code: '55000' } }) });
    expect(await processDocumentJob({ db, store: await storeWith(bytes, 'text/plain'), log }, job(bytes, 'text/plain'))).toEqual({ kind: 'lease_lost' });
    expect(db.calls.some((c) => c.fn === 'fail_document_job')).toBe(false);
  });

  it('claims a batch, logs ids and outcome codes but never document text', async () => {
    logs.length = 0;
    const bytes = enc('CONFIDENTIAL salary table for 2027');
    const store = await storeWith(bytes, 'text/plain');
    const db = fakeDb({ claim_document_jobs: () => ({ data: [job(bytes, 'text/plain')], error: null }) });
    expect(await runKnowledgeBatch({ db, store, log }, { workerId: 'w1', batchSize: 3 })).toBe(1);
    expect(db.calls[0]).toEqual({ fn: 'claim_document_jobs', args: { p_worker: 'w1', p_limit: 3, p_lease_seconds: 300 } });
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain(DOC);
    expect(serialized).not.toContain('CONFIDENTIAL');
    expect(serialized).not.toContain('salary');
  });
});
