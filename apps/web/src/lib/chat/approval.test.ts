import { describe, expect, it, vi } from 'vitest';
import {
  approvalReducer, checkApproval, DISPLAY_LIMITS, displayArguments, INITIAL_APPROVAL, parsePendingApproval, REDACTED, requestApproval, revokeApproval,
  type ApprovalAction, type ApprovalState, type PendingApproval,
} from './approval';
import { argumentsSha256, pendingApproval } from './approval.server';

const T = 'c0000000-0000-4000-8000-000000000001';
const EP = 'e0000000-0000-4000-8000-00000000000a';
const args = { title: 'VPN broken', api_token: 'tok_live_123', nested: { password: 'p@ss', note: 'ok' } };
const base: PendingApproval = pendingApproval(
  { endpointId: EP, endpointName: 'Acme Docs', endpointHost: 'mcp.acme.test', capability: 'external.create_ticket', toolName: 'create_ticket', toolDescription: 'Create a ticket', permissionClass: 'write' },
  { callId: 'call_1', threadId: T, arguments: args },
);

const res = (status: number, body: unknown) => Promise.resolve(new Response(body === undefined ? 'not json' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('parsePendingApproval', () => {
  it('accepts the server payload', () => {
    expect(parsePendingApproval(JSON.parse(JSON.stringify(base)))).toEqual(base);
  });
  it.each([
    ['read class', { permissionClass: 'read' }],
    ['unknown class', { permissionClass: 'admin' }],
    ['capability not matching the tool', { capability: 'external.delete_project' }],
    ['bad endpoint id', { endpointId: 'x' }],
    ['bad thread id', { threadId: '1' }],
    ['bad hash', { argumentsSha256: 'abc' }],
    ['host with a path', { endpointHost: 'mcp.acme.test/x?y=1' }],
    ['array arguments', { arguments: [] }],
    ['bad call id', { callId: 'a b' }],
  ])('rejects %s', (_n, over) => {
    expect(parsePendingApproval({ ...base, ...over })).toBeNull();
  });
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 1, []]) expect(parsePendingApproval(v)).toBeNull();
  });
});

describe('displayArguments', () => {
  it('redacts secrets by key at any depth and never copies their value', () => {
    const d = displayArguments(args);
    expect(d.lines).toEqual([
      { path: 'title', value: 'VPN broken', redacted: false, truncated: false },
      { path: 'api_token', value: REDACTED, redacted: true, truncated: false },
      { path: 'nested.password', value: REDACTED, redacted: true, truncated: false },
      { path: 'nested.note', value: 'ok', redacted: false, truncated: false },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/tok_live_123|p@ss/);
  });
  it('redacts a whole object under a secret key and credential-looking values under innocent keys', () => {
    const d = displayArguments({ credentials: { user: 'a', pass: 'b' }, header: 'Bearer abc.def', note: 'eyJhbGciOi.eyJzdWIiOi.sig', key: 'ghp_' + 'a'.repeat(30), Authorization: 'x', cookie: 'c=1' });
    expect(d.lines.map((l) => [l.path, l.redacted])).toEqual([
      ['credentials', true], ['header', true], ['note', true], ['key', true], ['Authorization', true], ['cookie', true],
    ]);
  });
  it('truncates long values, limits depth and number of lines', () => {
    const long = 'x'.repeat(DISPLAY_LIMITS.maxValue + 50);
    const d1 = displayArguments({ long, deep: { a: { b: { c: { d: { e: 1 } } } } } });
    expect(d1.lines[0]).toMatchObject({ truncated: true });
    expect(Array.from(d1.lines[0].value)).toHaveLength(DISPLAY_LIMITS.maxValue + 1);
    expect(d1.lines[1]).toEqual({ path: 'deep.a.b.c', value: '(nested data not shown)', redacted: false, truncated: true });
    const many = Object.fromEntries(Array.from({ length: DISPLAY_LIMITS.maxLines + 5 }, (_, i) => [`k${i}`, i]));
    const d2 = displayArguments(many);
    expect(d2.lines).toHaveLength(DISPLAY_LIMITS.maxLines);
    expect(d2.omitted).toBe(5);
  });
  it('shows arrays, empties and scalars', () => {
    expect(displayArguments({ tags: ['a', 2], empty: {}, none: [], n: null, b: false }).lines.map((l) => `${l.path}=${l.value}`))
      .toEqual(['tags[0]=a', 'tags[1]=2', 'empty=(empty)', 'none=(empty list)', 'n=null', 'b=false']);
  });
});

describe('API clients never treat a failure as permission', () => {
  it('requestApproval: success only for 200 + {approved:true}, with Agent 2\'s body and CSRF header', async () => {
    const f = vi.fn(() => res(200, { approved: true }));
    expect(await requestApproval(base, 300, f)).toEqual({ ok: true, value: { approved: true } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/connect/mcp/approvals');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-tugpt-csrf']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ connectionId: EP, capability: 'external.create_ticket', argumentsSha256: base.argumentsSha256, ttlSeconds: 300 });
  });
  it.each([
    ['500 (service-role RPC bug)', () => res(500, { error: { code: 'INTERNAL', message: 'x' } }), 'unavailable'],
    ['403 member', () => res(403, { error: { code: 'FORBIDDEN', message: 'x' } }), 'forbidden'],
    ['401', () => res(401, {}), 'unauthenticated'],
    ['400', () => res(400, {}), 'invalid'],
    ['200 approved:false', () => res(200, { approved: false }), 'unexpected'],
    ['200 approved:"true"', () => res(200, { approved: 'true' }), 'unexpected'],
    ['200 malformed', () => res(200, undefined), 'unexpected'],
    ['201', () => res(201, { approved: true }), 'unexpected'],
    ['network', () => Promise.reject(new TypeError('offline')), 'network'],
  ])('requestApproval %s -> %s', async (_n, impl, reason) => {
    const r = await requestApproval(base, 300, vi.fn(impl as () => Promise<Response>));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it('requestApproval refuses a TTL outside the offered options without calling the server', async () => {
    const f = vi.fn(() => res(200, { approved: true }));
    expect((await requestApproval(base, 7200, f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('requestApproval keeps the error code for display', async () => {
    const r = await requestApproval(base, 300, vi.fn(() => res(500, { error: { code: 'INTERNAL', message: 'boom' } })));
    expect(r).toEqual({ ok: false, reason: 'unavailable', status: 500, code: 'INTERNAL' });
  });
  it('revokeApproval: {revoked:boolean} only', async () => {
    expect(await revokeApproval(base, vi.fn(() => res(200, { revoked: true })))).toEqual({ ok: true, value: { revoked: true } });
    expect(await revokeApproval(base, vi.fn(() => res(200, { revoked: false })))).toEqual({ ok: true, value: { revoked: false } });
    expect((await revokeApproval(base, vi.fn(() => res(200, {})))).ok).toBe(false);
    expect((await revokeApproval(base, vi.fn(() => res(403, {})))).ok).toBe(false);
  });
  it('checkApproval: GET with query, boolean only', async () => {
    const f = vi.fn(() => res(200, { approved: true }));
    expect(await checkApproval(base, f)).toEqual({ ok: true, value: { approved: true } });
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toBe(`/api/v1/chat/approvals/status?connectionId=${EP}&capability=external.create_ticket&argumentsSha256=${base.argumentsSha256}`);
    expect((await checkApproval(base, vi.fn(() => res(503, { error: 'x' })))).ok).toBe(false);
    expect((await checkApproval(base, vi.fn(() => res(200, { approved: 1 })))).ok).toBe(false);
  });
});

describe('approvalReducer', () => {
  const run = (...actions: ApprovalAction[]): ApprovalState => actions.reduce(approvalReducer, INITIAL_APPROVAL);
  it('approve -> approved -> run -> done', () => {
    expect(run({ type: 'approve' }, { type: 'approved', expiresAt: 10 }, { type: 'run' }, { type: 'run_done', ok: true })).toEqual({ kind: 'done', ok: true });
  });
  it('a failed approval cannot be run; it can be retried or rejected', () => {
    const failed = run({ type: 'approve' }, { type: 'approve_failed', reason: 'unavailable' });
    expect(failed).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(approvalReducer(failed, { type: 'run' })).toBe(failed);
    expect(approvalReducer(failed, { type: 'approved', expiresAt: 1 })).toBe(failed);
    expect(approvalReducer(failed, { type: 'approve' })).toEqual({ kind: 'approving' });
    expect(approvalReducer(failed, { type: 'reject' })).toEqual({ kind: 'rejected' });
  });
  it('cannot run without approving first', () => {
    expect(run({ type: 'run' })).toEqual(INITIAL_APPROVAL);
    expect(run({ type: 'approved', expiresAt: 1 })).toEqual(INITIAL_APPROVAL);
  });
  it('expiry and revoke close the card; a failed revoke keeps it approved', () => {
    const approved = run({ type: 'approve' }, { type: 'approved', expiresAt: 5 });
    expect(approvalReducer(approved, { type: 'expire' })).toEqual({ kind: 'expired' });
    expect(run({ type: 'approve' }, { type: 'approved', expiresAt: 5 }, { type: 'revoke' }, { type: 'revoke_done' })).toEqual({ kind: 'revoked' });
    expect(run({ type: 'approve' }, { type: 'approved', expiresAt: 5 }, { type: 'revoke', then: 'rejected' }, { type: 'revoke_done' })).toEqual({ kind: 'rejected' });
    expect(run({ type: 'approve' }, { type: 'approved', expiresAt: 5 }, { type: 'revoke' }, { type: 'revoke_failed' })).toEqual({ kind: 'approved', expiresAt: 5 });
  });
  it('late responses do not reopen closed cards', () => {
    const rejected = run({ type: 'reject' });
    for (const a of [{ type: 'approved', expiresAt: 1 }, { type: 'run' }, { type: 'run_done', ok: true }, { type: 'expire' }] as ApprovalAction[]) {
      expect(approvalReducer(rejected, a)).toBe(rejected);
    }
  });
});

describe('argumentsSha256', () => {
  it('is key-order independent and matches the runtime algorithm', () => {
    expect(argumentsSha256({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(argumentsSha256({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    // sha256('{"a":1}')
    expect(argumentsSha256({ a: 1 })).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});
