/**
 * Unit tests for the Workspace backend library (no database). The database
 * rules themselves are covered by supabase/tests/database/workspace_*.test.sql
 * and, end to end through the routes, by workspace-api.integration.test.ts.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { argumentsSha256 } from '@/lib/chat/approval.server';
import { buildPreview, parseAction, parseCreate } from './approvals';
import { createWorkspaceClient } from './contracts';
import { parsePatch } from './conversations';
import { dbError } from './db';
import { WorkspaceError } from './errors';
import { chunkText, CHUNK_TARGET, decodeXmlEntities, docxXmlToText, extractText, readZipEntry } from './extract';
import { contentDisposition, readCappedBody, sanitizeFilename, validateUpload } from './files';
import { cleanName, isSameOriginRequest, parseCursor, parseLimit } from './http';
import { blobKey, configuredBlobStore, FilesystemBlobStore, maxUploadBytes, S3BlobStore, signV4, StorageError } from './storage';
import { makeDocx, makeZip } from './zip.test-harness';

const ORG = 'a0000000-0000-4000-8000-000000000000';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const enc = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof WorkspaceError ? `${e.status}:${e.code}` : String(e); } return 'no error'; };

describe('AWS Signature V4 (S3-compatible storage)', () => {
  // AWS S3 API reference, "Signature Calculations for the Authorization Header", worked examples.
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' };
  it('matches the published GET Object example', () => {
    const auth = signV4({ ...creds, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' } });
    expect(auth).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('matches the published PUT Object example', () => {
    const payloadHash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    const auth = signV4({ ...creds, method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: '/test%24file.text', payloadHash,
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-content-sha256': payloadHash, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } });
    expect(auth).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
});

describe('blob storage', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws-blob-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('derives keys only from validated UUIDs', () => {
    expect(blobKey(ORG, FILE)).toBe(`org/${ORG}/files/${FILE}`);
    for (const bad of ['../etc', `${ORG}/..`, '', 'x'.repeat(36)]) expect(() => blobKey(bad, FILE)).toThrow(StorageError);
    expect(() => blobKey(ORG, '../../passwd')).toThrow(StorageError);
  });
  it('filesystem store round-trips with private permissions and refuses foreign keys', async () => {
    const store = new FilesystemBlobStore(dir);
    const key = blobKey(ORG, FILE);
    await store.put(key, enc('hello'));
    expect(new TextDecoder().decode((await store.get(key))!)).toBe('hello');
    const file = path.join(dir, 'org', ORG, 'files', FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    for (const bad of ['../x', `org/${ORG}/files/../../../etc/passwd`, '/etc/passwd', `org/${ORG}/files/${FILE}/x`]) {
      await expect(store.get(bad)).rejects.toThrow(StorageError);
      await expect(store.put(bad, enc('x'))).rejects.toThrow(StorageError);
    }
    await store.delete(key);
    await store.delete(key); // idempotent
    expect(await store.get(key)).toBeNull();
    expect(() => new FilesystemBlobStore('relative/dir')).toThrow(StorageError);
  });
  it('S3 store signs path-style requests and never leaks endpoint or credentials in errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new S3BlobStore({ endpoint: 'https://s3.internal.example:9000', bucket: 'tugpt-files', region: 'eu-central-1', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-value' },
      async (url, init) => { calls.push({ url, init }); return new Response(calls.length === 2 ? 'gone' : 'boom', { status: calls.length === 2 ? 404 : 500 }); },
      () => new Date('2026-11-19T10:00:00Z'));
    await expect(store.put(blobKey(ORG, FILE), enc('x'), 'text/plain')).rejects.toThrow(StorageError);
    expect(await store.get(blobKey(ORG, FILE))).toBeNull();
    expect(calls[0].url).toBe(`https://s3.internal.example:9000/tugpt-files/org/${ORG}/files/${FILE}`);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261119\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(h['x-amz-date']).toBe('20261119T100000Z');
    expect(calls[0].init.redirect).toBe('error');
    try { await store.put(blobKey(ORG, FILE), enc('x'), 'text/plain'); } catch (e) {
      expect(String((e as Error).message)).toBe('STORAGE_UNAVAILABLE');
      expect(JSON.stringify(e)).not.toMatch(/secret-value|internal\.example|tugpt-files/);
    }
  });
  it('S3 store refuses non-HTTPS endpoints and malformed buckets', () => {
    const base = { bucket: 'b-1', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's' };
    expect(() => new S3BlobStore({ ...base, endpoint: 'http://s3.example' })).toThrow(StorageError);
    expect(() => new S3BlobStore({ ...base, endpoint: 'https://user:pw@s3.example' })).toThrow(StorageError);
    expect(() => new S3BlobStore({ ...base, endpoint: 'https://s3.example', bucket: '../x' })).toThrow(StorageError);
  });
  it('fails closed when storage is not configured', () => {
    expect(configuredBlobStore({})).toBeNull();
    expect(configuredBlobStore({ TUGPT_FILE_STORAGE: 'fs' })).toBeNull();
    expect(configuredBlobStore({ TUGPT_FILE_STORAGE: 's3', TUGPT_S3_ENDPOINT: 'http://insecure' })).toBeNull();
    expect(configuredBlobStore({ TUGPT_FILE_STORAGE: 'fs', TUGPT_FILE_STORAGE_DIR: dir })?.kind).toBe('fs');
  });
  it('caps the upload limit at the database ceiling', () => {
    expect(maxUploadBytes({})).toBe(25 * 1024 * 1024);
    expect(maxUploadBytes({ TUGPT_FILE_MAX_BYTES: '999999999' })).toBe(50 * 1024 * 1024);
    expect(maxUploadBytes({ TUGPT_FILE_MAX_BYTES: 'abc' })).toBe(25 * 1024 * 1024);
  });
});

describe('upload validation', () => {
  it('sanitizes filenames to a safe last segment', () => {
    expect(sanitizeFilename('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFilename('C:\\Users\\a\\Q3 report.pdf')).toBe('Q3 report.pdf');
    expect(sanitizeFilename('inv\u202eoice\u0000.txt')).toBe('invoice.txt');
    expect(sanitizeFilename('.hidden.md')).toBe('hidden.md');
    expect(Array.from(sanitizeFilename(`${'ä'.repeat(300)}.docx`)).length).toBe(255);
    expect(sanitizeFilename(`${'ä'.repeat(300)}.docx`).endsWith('.docx')).toBe(true);
    for (const bad of ['', '..', '/', '   ', 42, null]) expect(code(() => sanitizeFilename(bad))).toBe('400:INVALID_FILENAME');
  });
  it('accepts only allowlisted types whose extension, declared type and content agree', () => {
    expect(validateUpload('notes.md', 'text/markdown', enc('# Hi'))).toBe('text/markdown');
    expect(validateUpload('data.csv', 'application/vnd.ms-excel', enc('a,b'))).toBe('text/csv');
    expect(validateUpload('a.pdf', 'application/pdf', enc('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(validateUpload('a.png', 'application/octet-stream', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(validateUpload('d.docx', '', makeDocx(['x']))).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(code(() => validateUpload('x.svg', 'image/svg+xml', enc('<svg/>')))).toBe('415:UNSUPPORTED_MEDIA_TYPE');
    expect(code(() => validateUpload('x.html', 'text/html', enc('<script>')))).toBe('415:UNSUPPORTED_MEDIA_TYPE');
    expect(code(() => validateUpload('noext', 'text/plain', enc('x')))).toBe('415:UNSUPPORTED_MEDIA_TYPE');
    expect(code(() => validateUpload('a.png', 'image/png', enc('<html>not a png')))).toBe('415:MEDIA_TYPE_MISMATCH');
    expect(code(() => validateUpload('a.txt', 'text/html', enc('hi')))).toBe('415:MEDIA_TYPE_MISMATCH');
    expect(code(() => validateUpload('a.txt', 'text/plain', new Uint8Array([0x68, 0, 0x69])))).toBe('415:MEDIA_TYPE_MISMATCH');
    expect(code(() => validateUpload('a.txt', 'text/plain', new Uint8Array([0xff, 0xfe, 0xfd])))).toBe('415:MEDIA_TYPE_MISMATCH');
    expect(code(() => validateUpload('a.pdf', 'application/pdf', new Uint8Array()))).toBe('415:MEDIA_TYPE_MISMATCH');
  });
  it('stops reading the body as soon as it exceeds the cap', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); if (pulled > 100) c.close(); } });
    const req = new Request('https://app.test/x', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readCappedBody(req, 4096)).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(pulled).toBeLessThan(10);
    const declared = new Request('https://app.test/x', { method: 'POST', body: 'x', headers: { 'content-length': '999999' } });
    await expect(readCappedBody(declared, 10)).rejects.toMatchObject({ status: 413 });
  });
  it('builds an RFC 6266 attachment disposition that cannot break out of the header', () => {
    expect(contentDisposition('Q3 "final".pdf')).toBe(`attachment; filename="Q3 _final_.pdf"; filename*=UTF-8''Q3%20%22final%22.pdf`);
    expect(contentDisposition('Grüße.txt')).toContain("filename*=UTF-8''Gr%C3%BC%C3%9Fe.txt");
    expect(contentDisposition('a\r\nSet-Cookie: x.txt')).not.toMatch(/[\r\n]/);
  });
});

describe('extraction and chunking', () => {
  it('extracts UTF-8 text and normalises line endings', () => {
    expect(extractText(enc('\uFEFFHallo\r\nWelt'), 'text/plain')).toEqual({ kind: 'text', text: 'Hallo\nWelt' });
    expect(extractText(enc('   '), 'text/markdown')).toEqual({ kind: 'failed', code: 'EMPTY_DOCUMENT' });
  });
  it('extracts DOCX body text, dropping field codes and tracked deletions', () => {
    const docx = makeDocx(['Reisekostenrichtlinie 2027', 'Tom & Jerry <test>'],
      '<w:p><w:r><w:instrText>HYPERLINK "http://evil"</w:instrText></w:r><w:r><w:delText>removed secret</w:delText></w:r><w:r><w:t>kept</w:t></w:r></w:p>');
    const r = extractText(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.kind).toBe('text');
    const text = r.kind === 'text' ? r.text : '';
    expect(text).toContain('Reisekostenrichtlinie 2027');
    expect(text).toContain('Tom & Jerry <test>');
    expect(text).toContain('kept');
    expect(text).not.toMatch(/HYPERLINK|removed secret/);
  });
  it('reads stored zip entries and rejects corrupt or oversized archives', () => {
    expect(new TextDecoder().decode(readZipEntry(makeZip({ 'a.txt': 'abc' }, { store: true }), 'a.txt') as Uint8Array)).toBe('abc');
    expect(readZipEntry(enc('PK\u0003\u0004 not a zip'), 'word/document.xml')).toBeNull();
    const bomb = makeZip({ 'word/document.xml': 'a'.repeat(21 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(100_000);
    expect(readZipEntry(bomb, 'word/document.xml')).toBe('too_large');
    expect(extractText(bomb, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toEqual({ kind: 'failed', code: 'DOCUMENT_TOO_LARGE' });
  });
  it('marks PDFs and images unsupported for now instead of failing silently', () => {
    expect(extractText(enc('%PDF-1.7'), 'application/pdf')).toEqual({ kind: 'unsupported', code: 'PDF_EXTRACTION_UNAVAILABLE' });
    expect(extractText(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toEqual({ kind: 'unsupported', code: 'UNSUPPORTED_FOR_INDEXING' });
  });
  it('decodes XML entities safely', () => {
    expect(decodeXmlEntities('&lt;a&gt; &amp;amp; &#x1F600; &#55296; &bogus;')).toBe('<a> &amp; \u{1F600}  &bogus;');
    expect(docxXmlToText('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p>')).toBe('a\tb');
  });
  it('chunks paragraphs near the target size with overlap, never above 8000 chars', () => {
    const para = (n: number) => `Paragraph ${n} ` + 'lorem ipsum dolor sit amet '.repeat(20);
    const chunks = chunkText(Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n'));
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= CHUNK_TARGET + 200 && c.length > 0)).toBe(true);
    expect(chunkText('x'.repeat(20000)).every((c) => c.length <= 8000)).toBe(true);
    expect(chunkText('')).toEqual([]);
  });
});

describe('approval request helpers', () => {
  const base = { threadId: 'c0000000-0000-4000-8000-000000000001', connectionId: 'e0000000-0000-4000-8000-00000000000a', capability: 'external.send_invoice' };
  it('stores a redacted preview and never the secret values', () => {
    const preview = buildPreview({ to: 'ACME', api_token: 'tok_live_123', nested: { password: 'p@ss' }, auth: 'Bearer abc.def.ghi' });
    const json = JSON.stringify(preview);
    expect(json).toContain('ACME');
    expect(json).not.toMatch(/tok_live_123|p@ss|abc\.def\.ghi/);
    expect(preview.find((l) => l.path === 'api_token')?.redacted).toBe(true);
  });
  it('bounds the preview size', () => {
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 'v'.repeat(400)]));
    const preview = buildPreview(big);
    expect(new TextEncoder().encode(JSON.stringify(preview)).length).toBeLessThanOrEqual(12_300);
    expect(preview[preview.length - 1]).toMatchObject({ path: '…', truncated: true });
  });
  it('validates create input; the hash is computed server-side with the runtime function', () => {
    const input = parseCreate({ ...base, arguments: { b: 1, a: 'x' }, reason: '  Month end  ' });
    expect(input.reason).toBe('Month end');
    expect(argumentsSha256(input.arguments)).toBe(argumentsSha256({ a: 'x', b: 1 }));
    expect(code(() => parseCreate({ ...base, capability: 'send_invoice', arguments: {} }))).toBe('400:INVALID_CAPABILITY');
    expect(code(() => parseCreate({ ...base, threadId: 'nope', arguments: {} }))).toBe('400:INVALID_REQUEST');
    expect(code(() => parseCreate({ ...base, arguments: [1] }))).toBe('400:INVALID_REQUEST');
    expect(code(() => parseCreate({ ...base, arguments: { x: 'y'.repeat(17000) } }))).toBe('413:ARGUMENTS_TOO_LARGE');
  });
  it('validates actions strictly', () => {
    expect(parseAction({ action: 'approve' })).toEqual({ action: 'approve', ttlSeconds: 900 });
    expect(parseAction({ action: 'reject', note: 'no' })).toEqual({ action: 'reject', note: 'no' });
    expect(code(() => parseAction({ action: 'approve', ttlSeconds: 30 }))).toBe('400:INVALID_TTL');
    expect(code(() => parseAction({ action: 'approve', ttlSeconds: 3601 }))).toBe('400:INVALID_TTL');
    expect(code(() => parseAction({ action: 'cancel', note: 'x' }))).toBe('400:INVALID_REQUEST');
    expect(code(() => parseAction({ action: 'delete' }))).toBe('400:INVALID_DECISION');
  });
});

describe('request helpers and error mapping', () => {
  it('maps database errors to safe client codes without forwarding raw text', () => {
    expect(dbError({ code: '42501', message: 'new row violates row-level security policy for table "x"' })).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(dbError({ code: '22023', message: 'INVALID_CAPABILITY' })).toMatchObject({ status: 400, code: 'INVALID_CAPABILITY' });
    expect(dbError({ code: '22023', message: 'something internal' })).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    expect(dbError({ code: '55000', message: 'ALREADY_DECIDED' })).toMatchObject({ status: 409, code: 'ALREADY_DECIDED' });
    expect(dbError({ code: 'P0002', message: 'NOT_FOUND' })).toMatchObject({ status: 404 });
    expect(dbError({ code: '23503' })).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(dbError({ code: 'XX000', message: 'connection to 10.0.0.5 failed' })).toMatchObject({ status: 503, code: 'STORE_UNAVAILABLE' });
  });
  it('requires the exact origin, the CSRF header and no cross-site fetch', () => {
    process.env.TUGPT_APP_ORIGIN = 'https://app.test';
    const r = (h: Record<string, string>) => new Request('https://app.test/x', { method: 'DELETE', headers: h });
    expect(isSameOriginRequest(r({ origin: 'https://app.test', 'x-tugpt-csrf': '1' }))).toBe(true);
    expect(isSameOriginRequest(r({ origin: 'https://evil.test', 'x-tugpt-csrf': '1' }))).toBe(false);
    expect(isSameOriginRequest(r({ origin: 'https://app.test' }))).toBe(false);
    expect(isSameOriginRequest(r({ origin: 'https://app.test', 'x-tugpt-csrf': '1', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });
  it('validates names, limits, cursors and conversation patches', () => {
    expect(cleanName('  Q3\u0007 plan  ', 80)).toBe('Q3 plan');
    expect(code(() => cleanName('   ', 80))).toBe('400:INVALID_REQUEST');
    expect(parseLimit('500', 50, 100)).toBe(100);
    expect(code(() => parseLimit('-1', 50, 100))).toBe('400:INVALID_REQUEST');
    expect(parseCursor('2026-11-19T10:00:00Z')).toBe('2026-11-19T10:00:00.000Z');
    expect(code(() => parseCursor('yesterday'))).toBe('400:INVALID_REQUEST');
    expect(parsePatch({ archived: true, folderId: null })).toEqual({ archived: true, folderId: null });
    expect(code(() => parsePatch({}))).toBe('400:INVALID_REQUEST');
    expect(code(() => parsePatch({ archived: 'yes' }))).toBe('400:INVALID_REQUEST');
    expect(code(() => parsePatch({ folderId: '../x' }))).toBe('400:INVALID_REQUEST');
  });
});

describe('typed client', () => {
  it('sends CSRF + JSON on mutations, none on reads, and surfaces error codes', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const client = createWorkspaceClient(async (url, init) => {
      seen.push({ url, init });
      return url.includes('/approvals') ? Response.json({ error: 'FORBIDDEN' }, { status: 403 }) : Response.json({ threads: [], nextCursor: null });
    });
    expect(await client.listConversations({ q: 'budget' })).toEqual({ ok: true, value: { threads: [], nextCursor: null } });
    expect(seen[0].url).toBe('/api/v1/chat/threads?q=budget&archived=false');
    expect((seen[0].init?.headers as Record<string, string>)['x-tugpt-csrf']).toBeUndefined();
    expect(await client.actOnApproval('r1', { action: 'approve' })).toEqual({ ok: false, status: 403, error: 'FORBIDDEN' });
    const h = seen[1].init?.headers as Record<string, string>;
    expect(h['x-tugpt-csrf']).toBe('1');
    expect(h['content-type']).toBe('application/json');
    await client.uploadFile(new Blob(['x'], { type: 'text/plain' }), 'a b.txt');
    expect(seen[2].url).toBe('/api/v1/files?filename=a+b.txt&visibility=private');
    expect((seen[2].init?.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect(await createWorkspaceClient(async () => { throw new Error('offline'); }).listFolders()).toEqual({ ok: false, status: 0, error: 'NETWORK_ERROR' });
  });
});
