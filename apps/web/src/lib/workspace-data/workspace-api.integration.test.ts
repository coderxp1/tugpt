/**
 * End-to-end tests for the Workspace API: real route handlers -> real
 * PostgREST -> real Postgres with every RLS policy, grant and RPC from
 * migrations 20261119100001..04. One HS256 JWT per fixture user.
 *
 * Only `chatContext` (session + tenant resolution, covered by its own tests)
 * is replaced so each request can choose its user and tenant - including a
 * FORGED tenant (a user claiming an organization they do not belong to), to
 * prove the database rejects that on its own.
 *
 * Skipped unless WS_IT_POSTGREST_URL is set. See tests/workspace-it/README.md.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostgrestClient } from '@supabase/postgrest-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { argumentsSha256 } from '@/lib/chat/approval.server';
import { blobKey, FilesystemBlobStore, setBlobStoreForTests } from './storage';
import { makeDocx } from './zip.test-harness';

const URL_ = process.env.WS_IT_POSTGREST_URL;
const SECRET_FILE = process.env.WS_IT_JWT_SECRET_FILE;

const ORG_A = 'a4a00000-0000-4000-8000-00000000000a';
const ORG_B = 'a4b00000-0000-4000-8000-00000000000b';
const U = {
  ownerA: { id: 'a4111111-1111-4111-8111-111111111111', org: ORG_A, role: 'owner' },
  memberA: { id: 'a4222222-2222-4222-8222-222222222222', org: ORG_A, role: 'agent' },
  viewerA: { id: 'a4444444-4444-4444-8444-444444444444', org: ORG_A, role: 'viewer' },
  ownerB: { id: 'a4333333-3333-4333-8333-333333333333', org: ORG_B, role: 'owner' },
} as const;
type Actor = { id: string; org: string; role: string };
const T_MEMBER = 'a4700000-0000-4000-8000-0000000000a2';
const T_MEMBER2 = 'a4700000-0000-4000-8000-0000000000a3';
const T_OWNER = 'a4700000-0000-4000-8000-0000000000a1';
const T_B = 'a4700000-0000-4000-8000-0000000000b1';
const EP_A = 'a4e00000-0000-4000-8000-00000000000a';
const EP_B = 'a4e00000-0000-4000-8000-00000000000b';
const MISSING = 'a4f00000-0000-4000-8000-000000000000';

let current: { db: unknown; userId: string; tenant: Record<string, unknown> } | null = null;
vi.mock('@/lib/chat/request', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/chat/request')>();
  return { ...orig, chatContext: vi.fn(async () => current ?? orig.jsonError(401, 'Unauthenticated')) };
});

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
function jwt(sub: string, secret: string): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${head}.${body}.${b64(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
}

const ORIGIN = 'https://app.test';
type Params = Record<string, string>;
type Handler = (req: Request, ctx: { params: Promise<Params> }) => Promise<Response>;
type Route = Record<string, Handler | unknown>;

describe.skipIf(!URL_ || !SECRET_FILE)('workspace API against real PostgREST + RLS', () => {
  let secret = '';
  let blobDir = '';
  const clients = new Map<string, unknown>();
  const R: Record<string, Route> = {};

  /** Act as `who`; `org` overrides the tenant (forged-tenant cases). */
  function as(who: Actor, org: string = who.org) {
    if (!clients.has(who.id)) clients.set(who.id, new PostgrestClient(URL_!, { headers: { Authorization: `Bearer ${jwt(who.id, secret)}` } }));
    current = { db: clients.get(who.id), userId: who.id, tenant: { organizationId: org, organizationName: 'IT', role: who.role, locale: 'en' } };
  }
  async function call(route: string, method: string, opts: { params?: Params; query?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; csrf?: boolean } = {}) {
    const mutating = method !== 'GET';
    const headers: Record<string, string> = { ...(mutating && opts.csrf !== false ? { origin: ORIGIN, 'x-tugpt-csrf': '1' } : {}), ...opts.headers };
    let body: BodyInit | undefined = opts.raw;
    if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
    const req = new Request(`${ORIGIN}/x${opts.query ? `?${opts.query}` : ''}`, { method, headers, body });
    const res = await (R[route][method] as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
    const text = await res.clone().text();
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { /* binary download */ }
    return { status: res.status, json, text, res };
  }
  const upload = (filename: string, data: string | Uint8Array, type: string, visibility = 'private') =>
    call('files', 'POST', { query: new URLSearchParams({ filename, visibility }).toString(), raw: data as BodyInit, headers: { 'content-type': type } });

  beforeAll(async () => {
    secret = readFileSync(SECRET_FILE!, 'utf8').trim();
    process.env.TUGPT_APP_ORIGIN = ORIGIN;
    blobDir = mkdtempSync(path.join(os.tmpdir(), 'ws-it-blobs-'));
    setBlobStoreForTests(new FilesystemBlobStore(blobDir));
    const load = async (k: string, p: Promise<Route>) => { R[k] = await p; };
    await Promise.all([
      load('threads', import('@/app/api/v1/chat/threads/route')),
      load('thread', import('@/app/api/v1/chat/threads/[threadId]/route')),
      load('folders', import('@/app/api/v1/chat/folders/route')),
      load('folder', import('@/app/api/v1/chat/folders/[folderId]/route')),
      load('attachments', import('@/app/api/v1/chat/threads/[threadId]/attachments/route')),
      load('attachment', import('@/app/api/v1/chat/threads/[threadId]/attachments/[fileId]/route')),
      load('threadCollections', import('@/app/api/v1/chat/threads/[threadId]/collections/route')),
      load('threadCollection', import('@/app/api/v1/chat/threads/[threadId]/collections/[collectionId]/route')),
      load('approvals', import('@/app/api/v1/approvals/route')),
      load('approval', import('@/app/api/v1/approvals/[requestId]/route')),
      load('files', import('@/app/api/v1/files/route')),
      load('file', import('@/app/api/v1/files/[fileId]/route')),
      load('content', import('@/app/api/v1/files/[fileId]/content/route')),
      load('collections', import('@/app/api/v1/library/collections/route')),
      load('collection', import('@/app/api/v1/library/collections/[collectionId]/route')),
      load('documents', import('@/app/api/v1/library/collections/[collectionId]/documents/route')),
      load('document', import('@/app/api/v1/library/collections/[collectionId]/documents/[documentId]/route')),
      load('search', import('@/app/api/v1/library/search/route')),
    ]);
  }, 60_000);
  afterAll(() => { setBlobStoreForTests(undefined); current = null; if (blobDir) rmSync(blobDir, { recursive: true, force: true }); });

  // ------------------------------------------------------------ conversations
  describe('conversations', () => {
    it('lists only the caller\'s own threads, and searches titles and message text', async () => {
      as(U.memberA);
      const list = await call('threads', 'GET', { query: 'archived=false' });
      expect(list.status).toBe(200);
      const ids = list.json.threads.map((t: { id: string }) => t.id);
      expect(ids).toEqual(expect.arrayContaining([T_MEMBER, T_MEMBER2]));
      expect(ids).not.toContain(T_OWNER);
      expect(ids).not.toContain(T_B);
      const byTitle = await call('threads', 'GET', { query: 'q=budget' });
      expect(byTitle.json.threads.map((t: { id: string }) => t.id)).toEqual([T_MEMBER]);
      const byMessage = await call('threads', 'GET', { query: 'q=reconciliation' });
      expect(byMessage.json.threads).toHaveLength(1);
      expect(byMessage.json.threads[0]).toMatchObject({ id: T_MEMBER2, matchSource: 'message' });
      expect(byMessage.json.threads[0].snippet).toMatch(/reconciliation/i);
      expect(byMessage.json.threads[0].snippet).not.toMatch(/[<>]/);
      as(U.ownerA);
      expect((await call('threads', 'GET', { query: 'q=reconciliation' })).json.threads).toEqual([]);
    });

    it('renames, archives and restores; archived threads leave the default list', async () => {
      as(U.memberA);
      const renamed = await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { title: '  Budget FY27  ' } });
      expect(renamed.status).toBe(200);
      expect(renamed.json.thread.title).toBe('Budget FY27');
      expect((await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { archived: true } })).json.thread.archivedAt).toBeTruthy();
      expect((await call('threads', 'GET', { query: 'archived=false' })).json.threads.map((t: { id: string }) => t.id)).not.toContain(T_MEMBER);
      expect((await call('threads', 'GET', { query: 'archived=true' })).json.threads.map((t: { id: string }) => t.id)).toEqual([T_MEMBER]);
      expect((await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { archived: false } })).json.thread.archivedAt).toBeNull();
      expect((await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { title: 'x', modelKey: 'evil' } })).status).toBe(400);
    });

    it('manages folders: duplicate names conflict, filing and unfiled filters work, foreign folders are invisible', async () => {
      as(U.memberA);
      const f = await call('folders', 'POST', { body: { name: 'Finance' } });
      expect(f.status).toBe(201);
      const folderId = f.json.folder.id;
      expect((await call('folders', 'POST', { body: { name: 'finance' } })).json).toEqual({ error: 'ALREADY_EXISTS' });
      expect((await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { folderId } })).json.thread.folderId).toBe(folderId);
      expect((await call('threads', 'GET', { query: `folderId=${folderId}` })).json.threads.map((t: { id: string }) => t.id)).toEqual([T_MEMBER]);
      expect((await call('threads', 'GET', { query: 'unfiled=true' })).json.threads.map((t: { id: string }) => t.id)).toEqual([T_MEMBER2]);
      expect((await call('folder', 'PATCH', { params: { folderId }, body: { name: 'Finance & Ops' } })).json.folder.name).toBe('Finance & Ops');
      // The org owner cannot see or use the member's folder.
      as(U.ownerA);
      expect((await call('folders', 'GET')).json.folders).toEqual([]);
      expect((await call('thread', 'PATCH', { params: { threadId: T_OWNER }, body: { folderId } })).status).toBe(404);
      expect((await call('folder', 'DELETE', { params: { folderId } })).status).toBe(404);
      // Org B cannot file into an org-A folder, even with a forged tenant.
      as(U.ownerB);
      expect((await call('thread', 'PATCH', { params: { threadId: T_B }, body: { folderId } })).status).toBe(404);
      // Deleting the folder unfiles its threads instead of deleting them.
      as(U.memberA);
      expect((await call('folder', 'DELETE', { params: { folderId } })).status).toBe(200);
      expect((await call('thread', 'GET', { params: { threadId: T_MEMBER } })).status).toBe(200);
      expect((await call('threads', 'GET', { query: 'unfiled=true' })).json.threads).toHaveLength(2);
    });

    it('never lets anyone else - same-org owner, other tenant or forged tenant - modify a thread', async () => {
      as(U.ownerA);
      expect((await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { title: 'pwned' } })).status).toBe(404);
      expect((await call('thread', 'DELETE', { params: { threadId: T_MEMBER } })).status).toBe(404);
      as(U.ownerB);
      expect((await call('thread', 'PATCH', { params: { threadId: T_MEMBER }, body: { archived: true } })).status).toBe(404);
      as(U.ownerB, ORG_A); // forged
      expect((await call('thread', 'DELETE', { params: { threadId: T_MEMBER } })).status).toBe(404);
      expect((await call('threads', 'GET', { query: 'archived=false' })).json.threads ?? []).toEqual([]);
      as(U.memberA);
      expect((await call('thread', 'GET', { params: { threadId: T_MEMBER } })).json.thread?.title ?? 'present').not.toBe('pwned');
    });

    it('rejects mutations without the CSRF header or from another origin', async () => {
      as(U.memberA);
      expect((await call('thread', 'DELETE', { params: { threadId: T_MEMBER2 }, csrf: false })).json).toEqual({ error: 'INVALID_ORIGIN' });
      expect((await call('thread', 'DELETE', { params: { threadId: T_MEMBER2 }, csrf: false, headers: { origin: 'https://evil.test', 'x-tugpt-csrf': '1' } })).status).toBe(403);
      expect((await call('folders', 'POST', { body: { name: 'x' }, csrf: false })).status).toBe(403);
    });

    it('deletes the caller\'s own thread, after which it is gone for good', async () => {
      as(U.memberA); // T_MEMBER2 is not used after this point
      expect((await call('thread', 'DELETE', { params: { threadId: T_MEMBER2 } })).json).toEqual({ deleted: true });
      expect((await call('thread', 'GET', { params: { threadId: T_MEMBER2 } })).status).toBe(404);
      expect((await call('thread', 'DELETE', { params: { threadId: T_MEMBER2 } })).status).toBe(404);
      expect((await call('threads', 'GET', { query: 'q=reconciliation' })).json.threads).toEqual([]);
    });
  });

  // ------------------------------------------------------------ approvals
  describe('approvals', () => {
    const args = { invoice: 'INV-2027-001', amount: 1200, api_token: 'tok_live_SECRET', nested: { password: 'hunter2' } };
    let n = 0; // distinct arguments per request: identical pending requests are deduplicated by design
    const create = (extra: Record<string, unknown> = {}) =>
      call('approvals', 'POST', { body: { threadId: T_MEMBER, connectionId: EP_A, capability: 'external.send_invoice', arguments: { ...args, run: (n += 1) }, reason: 'Month-end run', ...extra } });

    it('creates a pending request with a redacted preview and the runtime argument hash', async () => {
      as(U.memberA);
      const r = await create();
      expect(r.status).toBe(201);
      const a = r.json.approval;
      expect(a).toMatchObject({ status: 'pending', source: 'request', threadId: T_MEMBER, capability: 'external.send_invoice', permissionClass: 'write', endpointName: 'Billing MCP' });
      expect(a.argumentsSha256).toBe(argumentsSha256({ ...args, run: n }));
      expect(r.text).not.toMatch(/tok_live_SECRET|hunter2/);
      expect(a.argumentsPreview.find((l: { path: string }) => l.path === 'invoice').value).toContain('INV-2027-001');
    });

    it('refuses requests for read tools, other users\' threads and other tenants\' connections', async () => {
      as(U.memberA);
      expect((await create({ capability: 'external.list_invoices' })).status).toBe(400);
      // Same code whether the target is foreign or nonexistent: nothing is enumerable.
      expect((await create({ threadId: T_OWNER })).json).toEqual({ error: 'INVALID_THREAD' });
      expect((await create({ threadId: MISSING })).json).toEqual({ error: 'INVALID_THREAD' });
      expect((await create({ connectionId: EP_B })).json).toEqual({ error: 'INVALID_ENDPOINT' });
      expect((await create({ connectionId: MISSING })).json).toEqual({ error: 'INVALID_ENDPOINT' });
      as(U.viewerA); // owns no thread, so cannot raise a request on anyone else's
      expect((await call('approvals', 'POST', { body: { threadId: T_MEMBER, connectionId: EP_A, capability: 'external.send_invoice', arguments: {} } })).json).toEqual({ error: 'INVALID_THREAD' });
      as(U.memberA);
      const first = (await create({ arguments: { same: true } })).json.approval.id;
      expect((await create({ arguments: { same: true } })).json.approval.id).toBe(first);
    });

    it('lets owner/admin approve; requester, viewer, other tenant and forged tenant cannot', async () => {
      as(U.memberA);
      const id = (await create()).json.approval.id;
      expect((await call('approval', 'POST', { params: { requestId: id }, body: { action: 'approve' } })).status).toBe(403);
      as(U.viewerA);
      expect((await call('approval', 'POST', { params: { requestId: id }, body: { action: 'approve' } })).status).toBe(403);
      as(U.ownerB);
      expect((await call('approval', 'GET', { params: { requestId: id } })).status).toBe(404);
      expect((await call('approval', 'POST', { params: { requestId: id }, body: { action: 'approve' } })).status).toBe(404);
      as(U.ownerB, ORG_A); // forged: rejected by the membership check before any row is read
      expect((await call('approval', 'GET', { params: { requestId: id } })).json).toEqual({ error: 'FORBIDDEN' });
      expect([403, 404]).toContain((await call('approval', 'POST', { params: { requestId: id }, body: { action: 'approve' } })).status);
      expect((await call('approvals', 'GET', { query: 'scope=org' })).json.approvals ?? []).toEqual([]);

      as(U.ownerA);
      const approved = await call('approval', 'POST', { params: { requestId: id }, body: { action: 'approve', ttlSeconds: 600, note: 'ok' } });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ id, action: 'approve', changed: true });
      expect(approved.json.toolApprovalId).toBeTruthy();
      expect((await call('approval', 'POST', { params: { requestId: id }, body: { action: 'reject' } })).json).toEqual({ error: 'ALREADY_DECIDED' });
      const rec = (await call('approval', 'GET', { params: { requestId: id } })).json.approval;
      expect(rec).toMatchObject({ status: 'approved', decisionNote: 'ok', decidedBy: { id: U.ownerA.id } });

      // Revoke: the underlying Agent-2 tool approval is revoked too.
      const revoked = await call('approval', 'POST', { params: { requestId: id }, body: { action: 'revoke' } });
      expect(revoked.json).toMatchObject({ action: 'revoke', changed: true });
      expect((await call('approval', 'GET', { params: { requestId: id } })).json.approval.status).toBe('revoked');
      expect((await call('approval', 'POST', { params: { requestId: id }, body: { action: 'revoke' } })).json.changed).toBe(false);
    });

    it('supports reject and requester-cancel, and keeps a filterable history', async () => {
      as(U.memberA);
      const rej = (await create()).json.approval.id;
      const can = (await create()).json.approval.id;
      expect((await call('approval', 'POST', { params: { requestId: can }, body: { action: 'cancel' } })).json.changed).toBe(true);
      as(U.ownerA);
      expect((await call('approval', 'POST', { params: { requestId: can }, body: { action: 'approve' } })).json).toEqual({ error: 'ALREADY_DECIDED' });
      expect((await call('approval', 'POST', { params: { requestId: rej }, body: { action: 'reject', note: 'Wrong amount' } })).status).toBe(200);
      // Only the requester can cancel; anyone else gets a no-op.
      expect((await call('approval', 'POST', { params: { requestId: rej }, body: { action: 'cancel' } })).json.changed).toBe(false);
      as(U.memberA);
      const pend = (await create()).json.approval.id;
      as(U.ownerA);
      expect((await call('approval', 'POST', { params: { requestId: pend }, body: { action: 'cancel' } })).json.changed).toBe(false);
      expect((await call('approval', 'GET', { params: { requestId: pend } })).json.approval.status).toBe('pending');

      const org = (await call('approvals', 'GET', { query: 'scope=org' })).json.approvals;
      const statuses = new Map(org.map((a: { id: string; status: string }) => [a.id, a.status]));
      expect(statuses.get(rej)).toBe('rejected');
      expect(statuses.get(can)).toBe('cancelled');
      const onlyRejected = (await call('approvals', 'GET', { query: 'scope=org&status=rejected' })).json.approvals;
      expect(onlyRejected.every((a: { status: string }) => a.status === 'rejected')).toBe(true);
      expect((await call('approvals', 'GET', { query: 'scope=nope' })).status).toBe(400);
      as(U.memberA);
      expect((await call('approvals', 'GET', { query: 'scope=org' })).status).toBe(403);
      expect((await call('approvals', 'GET', { query: 'scope=mine' })).json.approvals.length).toBeGreaterThanOrEqual(3);
      as(U.ownerB);
      expect((await call('approvals', 'GET', { query: 'scope=org' })).json.approvals).toEqual([]);
    });
  });

  // ------------------------------------------------------------ files
  describe('files', () => {
    let privateFile = '';
    let sharedFile = '';

    it('uploads without leaking storage keys or paths, and stores the bytes under the tenant prefix', async () => {
      as(U.memberA);
      const r = await upload('../../Q3 notes.md', '# Q3\nRevenue up.', 'text/markdown');
      expect(r.status).toBe(201);
      expect(r.json.file).toMatchObject({ filename: 'Q3 notes.md', mediaType: 'text/markdown', sizeBytes: 16, status: 'ready', visibility: 'private', ownedByMe: true });
      expect(r.text).not.toContain(blobDir);
      expect(r.text).not.toMatch(/org\/|files\/|storage|bucket|key/i);
      privateFile = r.json.file.id;
      expect(existsSync(path.join(blobDir, blobKey(ORG_A, privateFile)))).toBe(true);
      sharedFile = (await upload('policy.txt', 'Travel policy: economy class.', 'text/plain', 'organization')).json.file.id;
    });

    it('rejects disallowed, mismatched, oversized and viewer uploads', async () => {
      as(U.memberA);
      expect((await upload('x.svg', '<svg/>', 'image/svg+xml')).json).toEqual({ error: 'UNSUPPORTED_MEDIA_TYPE' });
      expect((await upload('x.png', 'not a png', 'image/png')).json).toEqual({ error: 'MEDIA_TYPE_MISMATCH' });
      process.env.TUGPT_FILE_MAX_BYTES = '1024';
      try { expect((await upload('big.txt', 'a'.repeat(2048), 'text/plain')).json).toEqual({ error: 'PAYLOAD_TOO_LARGE' }); }
      finally { delete process.env.TUGPT_FILE_MAX_BYTES; }
      expect((await upload('x.txt', 'hi', 'text/plain', 'public')).status).toBe(400);
      expect((await call('files', 'POST', { query: 'filename=a.txt', raw: 'x', headers: { 'content-type': 'text/plain' }, csrf: false })).status).toBe(403);
      as(U.viewerA);
      expect((await upload('v.txt', 'viewer', 'text/plain')).status).toBe(403);
    });

    it('downloads with attachment disposition and hardened headers', async () => {
      as(U.memberA);
      const d = await call('content', 'GET', { params: { fileId: privateFile } });
      expect(d.status).toBe(200);
      expect(d.text).toBe('# Q3\nRevenue up.');
      expect(d.res.headers.get('content-disposition')).toMatch(/^attachment; filename="Q3 notes.md"/);
      expect(d.res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(d.res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(d.res.headers.get('cache-control')).toMatch(/no-store/);
      expect(d.res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    });

    it('private files are owner-only; organization files are readable by the org only', async () => {
      for (const who of [U.ownerA, U.viewerA]) {
        as(who);
        expect((await call('file', 'GET', { params: { fileId: privateFile } })).status).toBe(404);
        expect((await call('content', 'GET', { params: { fileId: privateFile } })).status).toBe(404);
        expect((await call('content', 'GET', { params: { fileId: sharedFile } })).text).toBe('Travel policy: economy class.');
      }
      as(U.viewerA);
      // Visible but not owned: 403 (a file the caller cannot see is 404).
      expect((await call('file', 'DELETE', { params: { fileId: sharedFile } })).json).toEqual({ error: 'FORBIDDEN' });
      expect((await call('file', 'PATCH', { params: { fileId: sharedFile }, body: { filename: 'x.txt' } })).json).toEqual({ error: 'FORBIDDEN' });
      as(U.ownerB);
      for (const fileId of [privateFile, sharedFile]) {
        expect((await call('file', 'GET', { params: { fileId } })).status).toBe(404);
        expect((await call('content', 'GET', { params: { fileId } })).status).toBe(404);
        expect((await call('file', 'DELETE', { params: { fileId } })).status).toBe(404);
      }
      expect((await call('files', 'GET', { query: 'scope=organization' })).json.files).toEqual([]);
      as(U.ownerB, ORG_A); // forged: also may not read through the A storage prefix
      expect((await call('content', 'GET', { params: { fileId: sharedFile } })).status).toBe(404);
      expect((await call('files', 'GET', { query: 'scope=organization' })).json.files ?? []).toEqual([]);
    });

    it('attaches files to own threads only; deleting a file detaches it and removes the blob', async () => {
      as(U.memberA);
      const tmp = (await upload('scratch.csv', 'a,b\n1,2', 'text/csv')).json.file.id;
      expect((await call('attachments', 'POST', { params: { threadId: T_MEMBER }, body: { fileId: tmp } })).status).toBe(201);
      expect((await call('attachments', 'POST', { params: { threadId: T_MEMBER }, body: { fileId: sharedFile } })).status).toBe(201);
      expect((await call('attachments', 'POST', { params: { threadId: T_OWNER }, body: { fileId: tmp } })).status).toBe(404);
      const list = (await call('attachments', 'GET', { params: { threadId: T_MEMBER } })).json.attachments;
      expect(list.map((a: { file: { id: string } }) => a.file.id).sort()).toEqual([tmp, sharedFile].sort());
      as(U.ownerA);
      expect((await call('attachments', 'POST', { params: { threadId: T_OWNER }, body: { fileId: privateFile } })).status).toBe(404);
      expect((await call('attachments', 'GET', { params: { threadId: T_MEMBER } })).status).toBe(404);
      as(U.memberA);
      expect((await call('attachment', 'DELETE', { params: { threadId: T_MEMBER, fileId: sharedFile } })).status).toBe(200);
      expect((await call('file', 'DELETE', { params: { fileId: tmp } })).status).toBe(200);
      expect(existsSync(path.join(blobDir, blobKey(ORG_A, tmp)))).toBe(false);
      expect((await call('attachments', 'GET', { params: { threadId: T_MEMBER } })).json.attachments).toEqual([]);
      expect((await call('file', 'GET', { params: { fileId: tmp } })).status).toBe(404);
    });

    it('refuses to serve a blob whose bytes no longer match the recorded hash', async () => {
      as(U.memberA);
      const id = (await upload('tamper.txt', 'original', 'text/plain')).json.file.id;
      writeFileSync(path.join(blobDir, blobKey(ORG_A, id)), 'tampered');
      expect((await call('content', 'GET', { params: { fileId: id } })).json).toEqual({ error: 'INTEGRITY_CHECK_FAILED' });
    });

    it('fails closed when storage is not configured', async () => {
      setBlobStoreForTests(null);
      try { as(U.memberA); expect((await upload('n.txt', 'x', 'text/plain')).json).toEqual({ error: 'STORAGE_NOT_CONFIGURED' }); }
      finally { setBlobStoreForTests(new FilesystemBlobStore(blobDir)); }
    });
  });

  // ------------------------------------------------------------ library
  describe('knowledge library', () => {
    let privateCol = '';
    let orgCol = '';

    it('creates private collections for members; organization collections need owner/admin', async () => {
      as(U.memberA);
      const c = await call('collections', 'POST', { body: { name: 'My research', description: 'notes' } });
      expect(c.status).toBe(201);
      expect(c.json.collection).toMatchObject({ visibility: 'private', ownedByMe: true });
      privateCol = c.json.collection.id;
      expect((await call('collections', 'POST', { body: { name: 'Shared', visibility: 'organization' } })).status).toBe(403);
      as(U.viewerA);
      expect((await call('collections', 'POST', { body: { name: 'v' } })).status).toBe(403);
      as(U.ownerA);
      orgCol = (await call('collections', 'POST', { body: { name: 'Company policies', visibility: 'organization' } })).json.collection.id;
    });

    it('indexes Markdown and DOCX, reports PDFs as unsupported, and searches with plain-text snippets', async () => {
      as(U.memberA);
      const md = (await upload('roadmap.md', '# Roadmap\n\nThe <b>quantum</b> ledger migration ships in Q2.', 'text/markdown')).json.file.id;
      const docx = (await upload('richtlinie.docx', makeDocx(['Reisekostenrichtlinie', 'Bahnfahrten erster Klasse ab vier Stunden.']), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).json.file.id;
      const pdf = (await upload('scan.pdf', '%PDF-1.7\n%fake', 'application/pdf')).json.file.id;
      const d1 = await call('documents', 'POST', { params: { collectionId: privateCol }, body: { fileId: md } });
      expect(d1.status).toBe(201);
      expect(d1.json.document).toMatchObject({ status: 'ready', title: 'roadmap.md' });
      expect(d1.json.document.chunkCount).toBeGreaterThan(0);
      expect((await call('documents', 'POST', { params: { collectionId: privateCol }, body: { fileId: docx, title: 'Travel policy' } })).json.document.status).toBe('ready');
      expect((await call('documents', 'POST', { params: { collectionId: privateCol }, body: { fileId: pdf } })).json.document).toMatchObject({ status: 'unsupported', errorCode: 'PDF_EXTRACTION_UNAVAILABLE', chunkCount: 0 });
      expect((await call('documents', 'POST', { params: { collectionId: privateCol }, body: { fileId: md } })).status).toBe(409);

      const hits = (await call('search', 'GET', { query: 'q=quantum ledger' })).json.hits;
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ collectionId: privateCol, fileId: md });
      expect(hits[0].snippet).toMatch(/quantum/);
      expect(hits[0].snippet).not.toMatch(/<\/?b>/);
      expect((await call('search', 'GET', { query: 'q=Bahnfahrten' })).json.hits[0].title).toBe('Travel policy');
      expect((await call('collection', 'GET', { params: { collectionId: privateCol } })).json.documents).toHaveLength(3);

      // Not even the org owner sees a member's private collection.
      as(U.ownerA);
      expect((await call('search', 'GET', { query: 'q=quantum' })).json.hits).toEqual([]);
      expect((await call('collection', 'GET', { params: { collectionId: privateCol } })).status).toBe(404);
      expect((await call('documents', 'POST', { params: { collectionId: privateCol }, body: { fileId: md } })).status).toBe(404);
    });

    it('organization collections are searchable by viewers and invisible to other tenants', async () => {
      as(U.ownerA);
      const f = (await upload('expenses.txt', 'Expense reports are due by the fifth working day.', 'text/plain', 'organization')).json.file.id;
      expect((await call('documents', 'POST', { params: { collectionId: orgCol }, body: { fileId: f } })).json.document.status).toBe('ready');
      as(U.viewerA);
      expect((await call('search', 'GET', { query: `q=expense&collectionIds=${orgCol}` })).json.hits).toHaveLength(1);
      expect((await call('documents', 'POST', { params: { collectionId: orgCol }, body: { fileId: f } })).status).toBe(403);
      as(U.memberA);
      expect((await call('collection', 'DELETE', { params: { collectionId: orgCol } })).status).toBe(403);
      as(U.ownerB);
      expect((await call('search', 'GET', { query: 'q=expense' })).json.hits).toEqual([]);
      expect((await call('collection', 'GET', { params: { collectionId: orgCol } })).status).toBe(404);
      expect((await call('collections', 'GET')).json.collections).toEqual([]);
      as(U.ownerB, ORG_A); // forged
      expect((await call('search', 'GET', { query: 'q=expense' })).json.hits ?? []).toEqual([]);
      expect((await call('collection', 'DELETE', { params: { collectionId: orgCol } })).status).toBe(404);
    });

    it('links readable collections to own threads only', async () => {
      as(U.memberA);
      expect((await call('threadCollections', 'POST', { params: { threadId: T_MEMBER }, body: { collectionId: orgCol } })).status).toBe(201);
      expect((await call('threadCollections', 'POST', { params: { threadId: T_MEMBER }, body: { collectionId: privateCol } })).status).toBe(201);
      expect((await call('threadCollections', 'GET', { params: { threadId: T_MEMBER } })).json.collections.map((c: { id: string }) => c.id).sort()).toEqual([orgCol, privateCol].sort());
      expect((await call('threadCollections', 'POST', { params: { threadId: T_OWNER }, body: { collectionId: orgCol } })).status).toBe(404);
      expect((await call('threadCollection', 'DELETE', { params: { threadId: T_MEMBER, collectionId: privateCol } })).status).toBe(200);
      as(U.ownerA);
      expect((await call('threadCollections', 'POST', { params: { threadId: T_OWNER }, body: { collectionId: privateCol } })).status).toBe(404);
      as(U.ownerB);
      expect((await call('threadCollections', 'POST', { params: { threadId: T_B }, body: { collectionId: orgCol } })).status).toBe(404);
    });

    it('returns 404 for unknown ids and 400 for malformed input', async () => {
      as(U.memberA);
      expect((await call('collection', 'GET', { params: { collectionId: MISSING } })).status).toBe(404);
      expect((await call('collection', 'GET', { params: { collectionId: 'not-a-uuid' } })).status).toBe(404);
      expect((await call('search', 'GET', { query: 'q=' })).status).toBe(400);
      expect((await call('search', 'GET', { query: 'q=x&collectionIds=../etc' })).status).toBe(400);
    });
  });
});
