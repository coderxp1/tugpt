import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  blobKey, chunkText, configuredEmbeddings, EmbeddingsClient, EmbeddingsError, embeddingsConfig, extractDocument, extractText,
  FilesystemBlobStore, MemoryBlobStore, orgPrefix, parseBlobKey, readZipEntry, S3BlobStore, StorageError, toVectorLiteral,
  XLSX_MEDIA_TYPE, zipEntries, type BlobEntry, type BlobStore,
} from './index';
import { extractPdfText, pdfExtractor } from './pdf';
import { makePdf, makeXlsx, makeZip } from './fixtures.test-util';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';
const F1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function all(it: AsyncIterable<BlobEntry>): Promise<BlobEntry[]> { const out: BlobEntry[] = []; for await (const e of it) out.push(e); return out; }

describe('zip reader', () => {
  it('lists entries and reads stored and deflated data', () => {
    const z = makeZip({ 'a.txt': 'alpha', 'b/c.xml': '<x/>' });
    expect(zipEntries(z)?.map((e) => e.name)).toEqual(['a.txt', 'b/c.xml']);
    expect(new TextDecoder().decode(readZipEntry(z, 'a.txt') as Uint8Array)).toBe('alpha');
    expect(new TextDecoder().decode(readZipEntry(makeZip({ s: 'stored' }, { store: true }), 's') as Uint8Array)).toBe('stored');
  });
  it('caps inflation (zip bomb) and rejects garbage', () => {
    const bomb = makeZip({ big: 'A'.repeat(3_000_000) });
    expect(readZipEntry(bomb, 'big', 1_000_000)).toBe('too_large');
    expect(zipEntries(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readZipEntry(bomb, 'missing')).toBeNull();
  });
});

describe('XLSX extraction', () => {
  const cells = (r: number, xs: string) => `<row r="${r}">${xs}</row>`;
  it('reads shared, inline, boolean and numeric cells in workbook sheet order', () => {
    const xlsx = makeXlsx([
      ['Revenue', cells(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>') + cells(2, '<c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c><c r="C2" t="b"><v>1</v></c>')],
      ['Notes &amp; Risks', cells(1, '<c r="A1" t="inlineStr"><is><t>Inline &lt;tag&gt; text</t></is></c><c r="B1" t="e"><v>#DIV/0!</v></c>') + '<row r="2"/>'],
    ], ['<t>Region</t>', '<r><t>Q1 </t></r><r><t>total</t></r>', '<t>EMEA</t><rPh><t>phonetic</t></rPh>']);
    const r = extractText(xlsx, XLSX_MEDIA_TYPE);
    expect(r.kind).toBe('text');
    const text = r.kind === 'text' ? r.text : '';
    expect(text).toBe([
      'Sheet: Revenue', 'Revenue!1: Region | Q1 total', 'Revenue!2: EMEA | 1234.5 | TRUE',
      'Sheet: Notes & Risks', 'Notes & Risks!1: Inline <tag> text',
    ].join('\n\n'));
    expect(text).not.toContain('phonetic');
    expect(text).not.toContain('#DIV/0!');
  });
  it('fails closed on missing worksheets, garbage and oversized sheets', () => {
    expect(extractText(makeZip({ 'xl/workbook.xml': '<workbook/>' }), XLSX_MEDIA_TYPE)).toEqual({ kind: 'failed', code: 'EXTRACTION_FAILED' });
    expect(extractText(new TextEncoder().encode('not a zip'), XLSX_MEDIA_TYPE)).toEqual({ kind: 'failed', code: 'EXTRACTION_FAILED' });
    const huge = makeXlsx([['S', `<row r="1"><c t="inlineStr"><is><t>${'x'.repeat(21 * 1024 * 1024)}</t></is></c></row>`]]);
    expect(extractText(huge, XLSX_MEDIA_TYPE)).toEqual({ kind: 'failed', code: 'DOCUMENT_TOO_LARGE' });
  });
  it('produces row-aligned chunks', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `<row r="${i + 1}"><c t="inlineStr"><is><t>item ${i} ${'w'.repeat(20)}</t></is></c></row>`).join('');
    const r = extractText(makeXlsx([['Big', rows]]), XLSX_MEDIA_TYPE);
    const chunks = r.kind === 'text' ? chunkText(r.text) : [];
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500 + 200);
  });
});

describe('PDF extraction (pdf.js)', () => {
  it('extracts text from a real multi-page PDF', async () => {
    const pdf = makePdf([['Quarterly report (draft)', 'Revenue grew in EMEA'], ['Second page: action items']]);
    const r = await extractDocument(pdf, 'application/pdf', { pdf: pdfExtractor });
    expect(r.kind).toBe('text');
    const text = r.kind === 'text' ? r.text : '';
    expect(text).toContain('Quarterly report (draft)');
    expect(text).toContain('Revenue grew in EMEA');
    expect(text).toContain('Second page: action items');
    expect(text.indexOf('Quarterly')).toBeLessThan(text.indexOf('Second page'));
  });
  it('reports a PDF with no text layer, page limits and malformed input', async () => {
    expect(await extractDocument(makePdf([[]]), 'application/pdf', { pdf: pdfExtractor })).toEqual({ kind: 'failed', code: 'PDF_NO_TEXT_LAYER' });
    await expect(extractPdfText(makePdf([['a'], ['b']]), { maxPages: 1 })).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    const bad = await extractDocument(new TextEncoder().encode('%PDF-1.4\nthis is not a pdf'), 'application/pdf', { pdf: pdfExtractor });
    expect(bad.kind).toBe('failed');
  });
  it('without an extractor PDF stays unsupported (web path)', async () => {
    expect(await extractDocument(makePdf([['x']]), 'application/pdf')).toEqual({ kind: 'unsupported', code: 'PDF_EXTRACTION_UNAVAILABLE' });
    expect(extractText(makePdf([['x']]), 'application/pdf')).toEqual({ kind: 'unsupported', code: 'PDF_EXTRACTION_UNAVAILABLE' });
  });
});

describe('BlobStore.list', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'wscore-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('filesystem: lists derived keys only, per org or all orgs', async () => {
    const fs = new FilesystemBlobStore(dir);
    await fs.put(blobKey(ORG, F1), new Uint8Array([1, 2, 3]), 'text/plain');
    await fs.put(blobKey(ORG2, F2), new Uint8Array([4]), 'text/plain');
    await writeFile(path.join(dir, 'org', ORG, 'files', `${F2}.x.tmp`), 'partial');
    await mkdir(path.join(dir, 'org', 'not-a-uuid', 'files'), { recursive: true });
    await writeFile(path.join(dir, 'org', 'not-a-uuid', 'files', F1), 'foreign');
    const everything = await all(fs.list('org/'));
    expect(everything.map((e) => e.key).sort()).toEqual([blobKey(ORG, F1), blobKey(ORG2, F2)].sort());
    expect(everything.find((e) => e.key === blobKey(ORG, F1))?.size).toBe(3);
    expect((await all(fs.list(orgPrefix(ORG)))).map((e) => e.key)).toEqual([blobKey(ORG, F1)]);
    expect(await all(new FilesystemBlobStore(path.join(dir, 'empty')).list('org/'))).toEqual([]);
  });
  it('rejects prefixes outside the derived key space', async () => {
    const m = new MemoryBlobStore();
    for (const p of ['', 'org', '../', 'org/../', `org/${ORG}/files/${F1}`, 'other/']) {
      await expect(all(m.list(p))).rejects.toBeInstanceOf(StorageError);
    }
    expect(() => orgPrefix('nope')).toThrow(StorageError);
    expect(parseBlobKey(blobKey(ORG, F1))).toEqual({ organizationId: ORG, fileId: F1 });
    expect(parseBlobKey(`org/${ORG}/files/${F1}.tmp`)).toBeNull();
  });
  it('memory: lists with modification times', async () => {
    const m = new MemoryBlobStore();
    await m.put(blobKey(ORG, F1), new Uint8Array([1]), 'text/plain');
    const [e] = await all(m.list('org/'));
    expect(e.key).toBe(blobKey(ORG, F1));
    expect(Date.now() - e.modifiedAt.getTime()).toBeLessThan(5000);
  });
  it('s3: ListObjectsV2 with pagination, signed query, foreign keys skipped', async () => {
    const calls: string[] = [];
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok/1+=</NextContinuationToken>
        <Contents><Key>${blobKey(ORG, F1)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>10</Size></Contents>
        <Contents><Key>org/${ORG}/files/evil/../x</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>1</Size></Contents></ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated>
        <Contents><Key>${blobKey(ORG2, F2)}</Key><LastModified>2026-02-01T00:00:00.000Z</LastModified><Size>20</Size></Contents></ListBucketResult>`,
    ];
    const s3 = new S3BlobStore({ endpoint: 'https://s3.example.test', bucket: 'tugpt-files', region: 'eu-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      async (url, init) => {
        calls.push(url);
        expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
        return new Response(pages[calls.length - 1], { status: 200 });
      }, () => new Date('2026-03-01T00:00:00Z'));
    const entries = await all(s3.list('org/'));
    expect(entries.map((e) => [e.key, e.size])).toEqual([[blobKey(ORG, F1), 10], [blobKey(ORG2, F2), 20]]);
    expect(calls[0]).toBe('https://s3.example.test/tugpt-files?list-type=2&max-keys=1000&prefix=org%2F');
    expect(calls[1]).toContain('continuation-token=tok%2F1%2B%3D');
  });
  it('s3: list failure is a generic StorageError', async () => {
    const s3: BlobStore = new S3BlobStore({ endpoint: 'https://s3.example.test', bucket: 'tugpt-files', region: 'eu-central-1', accessKeyId: 'a', secretAccessKey: 'b' },
      async () => new Response('<Error>AccessDenied for secret-bucket</Error>', { status: 403 }));
    await expect(all(s3.list('org/'))).rejects.toThrow('STORAGE_UNAVAILABLE');
  });
});

describe('embeddings client', () => {
  const env = { TUGPT_EMBEDDINGS_URL: 'https://emb.example.test/v1/', TUGPT_EMBEDDINGS_MODEL: 'bge-m3', TUGPT_EMBEDDINGS_DIMS: '3', TUGPT_EMBEDDINGS_API_KEY: 'sk-test-secret' };
  it('validates configuration (fail closed)', () => {
    expect(embeddingsConfig(env)).toEqual({ baseUrl: 'https://emb.example.test/v1', model: 'bge-m3', dims: 3, apiKey: 'sk-test-secret' });
    expect(embeddingsConfig({ ...env, TUGPT_EMBEDDINGS_URL: 'http://emb.example.test/v1' })).toBeNull();
    expect(embeddingsConfig({ ...env, TUGPT_EMBEDDINGS_URL: 'http://127.0.0.1:8080/v1' })?.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(embeddingsConfig({ ...env, TUGPT_EMBEDDINGS_URL: 'https://u:p@emb.example.test/v1' })).toBeNull();
    expect(embeddingsConfig({ ...env, TUGPT_EMBEDDINGS_DIMS: '0' })).toBeNull();
    expect(embeddingsConfig({ ...env, TUGPT_EMBEDDINGS_DIMS: '5000' })).toBeNull();
    expect(embeddingsConfig({ ...env, TUGPT_EMBEDDINGS_MODEL: undefined })).toBeNull();
    expect(configuredEmbeddings({})).toBeNull();
  });
  it('batches, reorders by index and sends the bearer token', async () => {
    const bodies: { input: string[]; model: string }[] = [];
    const client = new EmbeddingsClient(embeddingsConfig(env)!, async (url, init) => {
      expect(url).toBe('https://emb.example.test/v1/embeddings');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-secret');
      const body = JSON.parse(String(init.body)) as { input: string[]; model: string };
      bodies.push(body);
      const data = body.input.map((s, i) => ({ index: i, embedding: [s.length, i, 1] })).reverse();
      return Response.json({ data });
    });
    const inputs = Array.from({ length: 40 }, (_, i) => 'x'.repeat(i + 1));
    const out = await client.embed(inputs);
    expect(bodies.map((b) => b.input.length)).toEqual([32, 8]);
    expect(bodies[0].model).toBe('bge-m3');
    expect(out[0]).toEqual([1, 0, 1]);
    expect(out[39]).toEqual([40, 7, 1]);
  });
  it('rejects wrong dimensions, non-finite values and HTTP errors with generic codes', async () => {
    const mk = (f: () => Response) => new EmbeddingsClient(embeddingsConfig(env)!, async () => f());
    await expect(mk(() => Response.json({ data: [{ index: 0, embedding: [1, 2] }] })).embed(['a'])).rejects.toMatchObject({ code: 'EMBEDDINGS_INVALID_RESPONSE' });
    await expect(mk(() => Response.json({ data: [{ index: 0, embedding: [1, 2, null] }] })).embed(['a'])).rejects.toBeInstanceOf(EmbeddingsError);
    await expect(mk(() => Response.json({ data: [] })).embed(['a'])).rejects.toMatchObject({ code: 'EMBEDDINGS_INVALID_RESPONSE' });
    const err = await mk(() => new Response('upstream echoed: secret input', { status: 500 })).embed(['secret input']).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'EMBEDDINGS_UNAVAILABLE' });
    expect(String((err as Error).message)).not.toContain('secret');
    const net = await new EmbeddingsClient(embeddingsConfig(env)!, async () => { throw new Error('ECONNREFUSED sk-test-secret'); }).embed(['a']).catch((e: Error) => e);
    expect((net as Error).message).toBe('EMBEDDINGS_UNAVAILABLE');
  });
  it('formats pgvector literals', () => {
    expect(toVectorLiteral([0.5, -1, 2e-7])).toBe('[0.5,-1,2e-7]');
  });
});
