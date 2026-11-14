/**
 * Connect tool runtime + calendar.find_availability.
 *
 * The credential broker here is the REAL broker HTTP server (in-process,
 * throwaway keys); only Google is stubbed. Every refusal test also asserts
 * that no token was requested and Google was never called — authorization
 * must complete before any credential is touched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  BrokerClient,
  BrokerService,
  createBrokerServer,
  encryptCredential,
  InMemoryCredentialStore,
  MemoryAuditSink,
  type Caller,
  type KeyRing,
} from '@tugpt/credential-broker';
import { validateToolDefinitions, type ProposedToolCall } from '@tugpt/ai-providers';
import type { FreeBusyFetch } from '@tugpt/appointments';
import { ConnectToolRuntime } from './runtime.js';
import { createCalendarFindAvailabilityTool, MAX_AVAILABILITY_WINDOW_DAYS } from './google-calendar-tool.js';
import type {
  AccessTokenSource,
  ConnectionRecord,
  ConnectTool,
  ToolAuditEvent,
  ToolExecutionContext,
} from './types.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CONN = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONN_REVOKED = 'aaaaaaaa-0000-4000-8000-000000000002';
const CONN_PERSONAL = 'aaaaaaaa-0000-4000-8000-000000000003';
const CONN_EXPIRED = 'aaaaaaaa-0000-4000-8000-000000000004';
const CONN_NOSCOPE = 'aaaaaaaa-0000-4000-8000-000000000005';
const CONN_SLACK = 'aaaaaaaa-0000-4000-8000-000000000006';
const USER_1 = 'cccccccc-0000-4000-8000-000000000001';
const USER_2 = 'cccccccc-0000-4000-8000-000000000002';
const AGENT = 'dddddddd-0000-4000-8000-000000000001';
const FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy';
const NOW = Date.parse('2026-11-19T00:00:00Z');

/* ---------------- real broker ---------------- */
const ring: KeyRing = new Map([['org.v1', randomBytes(32)]]);
const workerKey = randomBytes(32);
const brokerAudit = new MemoryAuditSink();
let server: Server;
let broker: BrokerClient;

beforeAll(async () => {
  const store = new InMemoryCredentialStore();
  for (const connectionId of [CONN, CONN_REVOKED, CONN_PERSONAL]) {
    const id = { organizationId: ORG_A, connectionId, provider: 'google', kind: 'oauth_token_set', credentialVersion: 1 };
    store.seed({
      ...id,
      status: 'connected',
      expiresAt: '2099-01-01T00:00:00Z',
      encrypted: encryptCredential(
        JSON.stringify({ access_token: `AT-${connectionId.slice(-1)}`, refresh_token: 'RT-NEVER-LEAK', expires_at: '2099-01-01T00:00:00Z' }),
        id,
        'org.v1',
        ring
      ),
    });
  }
  const service = new BrokerService({ store, keyRing: ring, writeKeyId: 'org.v1', refresher: async () => { throw new Error('unused'); } });
  server = createBrokerServer({ service, audit: brokerAudit, callerKeys: new Map<Caller, Buffer[]>([['worker', [workerKey]]]) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  broker = new BrokerClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, caller: 'worker', key: workerKey });
  expect((await broker.revoke({ organizationId: ORG_A, connectionId: CONN_REVOKED })).ok).toBe(true);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/* ---------------- fakes ---------------- */
const conn = (id: string, extra: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id,
  organizationId: ORG_A,
  ownerUserId: null,
  provider: 'google',
  status: 'connected',
  grantedScopes: [FREEBUSY],
  ...extra,
});
const CONNECTIONS: ConnectionRecord[] = [
  conn(CONN),
  conn(CONN_REVOKED),
  conn(CONN_PERSONAL, { ownerUserId: USER_2 }),
  conn(CONN_EXPIRED, { status: 'expired' }),
  conn(CONN_NOSCOPE, { grantedScopes: ['https://www.googleapis.com/auth/calendar.events'] }),
  conn(CONN_SLACK, { provider: 'slack' }),
];

interface Harness {
  runtime: ConnectToolRuntime;
  audit: ToolAuditEvent[];
  tokenCalls: number;
  googleCalls: { url: string; auth: string; body: string }[];
  maxInFlight: number;
}

let googleStatus = 200;
let googleBusy: { start: string; end: string }[] = [];

function harness(over: {
  tools?: ConnectTool<never>[];
  policyEnabled?: boolean;
  grants?: Set<string>;
  directoryIgnoresOrg?: boolean;
  maxCallsPerTurn?: number;
  maxOutputBytes?: number;
  auditThrows?: boolean;
} = {}): Harness {
  const h: Harness = { runtime: undefined as never, audit: [], tokenCalls: 0, googleCalls: [], maxInFlight: 0 };
  let inFlight = 0;
  const fetchFn: FreeBusyFetch = async (url, init) => {
    inFlight += 1;
    h.maxInFlight = Math.max(h.maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    h.googleCalls.push({ url, auth: init.headers.Authorization ?? init.headers.authorization ?? '', body: init.body });
    inFlight -= 1;
    return {
      status: googleStatus,
      json: async () =>
        googleStatus === 200
          ? { calendars: { primary: { busy: googleBusy } } }
          : { error: { code: googleStatus, message: 'internal google detail must not reach the model' } },
    };
  };
  const tokens: AccessTokenSource = {
    getAccessToken: async (scope) => {
      h.tokenCalls += 1;
      return broker.getAccessToken(scope);
    },
  };
  const grants = over.grants ?? new Set([`${CONN}|${USER_1}`, `${CONN}|${AGENT}`, `${CONN_REVOKED}|${USER_1}`, `${CONN_PERSONAL}|${USER_1}`, `${CONN_PERSONAL}|${USER_2}`, `${CONN_EXPIRED}|${USER_1}`, `${CONN_NOSCOPE}|${USER_1}`, `${CONN_SLACK}|${USER_1}`]);
  h.runtime = new ConnectToolRuntime({
    tools: over.tools ?? [createCalendarFindAvailabilityTool({ fetchFn }) as ConnectTool<never>],
    connections: {
      getConnection: async (orgId, id) =>
        CONNECTIONS.find((c) => c.id === id && (over.directoryIgnoresOrg || c.organizationId === orgId)) ?? null,
    },
    policy: { isCapabilityEnabled: async () => over.policyEnabled ?? true },
    grants: {
      isGranted: async ({ connectionId, actorUserId, agentId, capability }) =>
        capability === 'calendar.find_availability' || capability.startsWith('test.')
          ? grants.has(`${connectionId}|${agentId ?? actorUserId}`)
          : false,
    },
    tokens,
    audit: {
      record: async (e) => {
        if (over.auditThrows) throw new Error('sink down');
        h.audit.push(e);
      },
    },
    now: () => NOW,
    ...(over.maxCallsPerTurn ? { maxCallsPerTurn: over.maxCallsPerTurn } : {}),
    ...(over.maxOutputBytes ? { maxOutputBytes: over.maxOutputBytes } : {}),
  });
  return h;
}

const ctx = (extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  organizationId: ORG_A,
  actorUserId: USER_1,
  agentId: null,
  connectionId: CONN,
  requestId: 'req-1',
  ...extra,
});
const ARGS = { start: '2026-11-20T09:00:00Z', end: '2026-11-20T11:00:00Z', durationMinutes: 30 };
const call = (args: Record<string, unknown> = ARGS, name = 'calendar_find_availability', id = 'call-1'): ProposedToolCall => ({ id, name, arguments: args });

beforeEach(() => {
  googleStatus = 200;
  googleBusy = [{ start: '2026-11-20T09:30:00Z', end: '2026-11-20T10:00:00Z' }];
});

/* ---------------- tests ---------------- */
describe('calendar.find_availability end-to-end (real broker, stubbed Google)', () => {
  it('returns computed free slots using the broker-issued token', async () => {
    const h = harness();
    const r = await h.runtime.executeCall(ctx(), call());
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content)).toEqual({
      ok: true,
      data: {
        timeZone: 'UTC',
        fetchedAt: '2026-11-19T00:00:00.000Z',
        slots: [
          { start: '2026-11-20T09:00:00.000Z', end: '2026-11-20T09:30:00.000Z' },
          { start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T10:30:00.000Z' },
          { start: '2026-11-20T10:30:00.000Z', end: '2026-11-20T11:00:00.000Z' },
        ],
      },
    });
    expect(h.googleCalls).toHaveLength(1);
    expect(h.googleCalls[0]!.url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(h.googleCalls[0]!.auth).toBe('Bearer AT-1');
    expect(JSON.parse(h.googleCalls[0]!.body).items).toEqual([{ id: 'primary' }]);
  });

  it('writes exactly one audit event with an argument hash, never raw args or tokens', async () => {
    const h = harness();
    await h.runtime.executeCall(ctx({ agentId: AGENT }), call());
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ organizationId: ORG_A, actorUserId: USER_1, agentId: AGENT, connectionId: CONN, capability: 'calendar.find_availability', outcome: 'ok' });
    expect(h.audit[0]!.argumentsSha256).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(h.audit);
    expect(dump).not.toMatch(/AT-1|RT-NEVER-LEAK|2026-11-20T09:00/);
    expect(JSON.stringify(brokerAudit.events)).not.toMatch(/AT-|RT-NEVER-LEAK/);
  });

  it('argument hash is order-independent (canonical JSON)', async () => {
    const h = harness();
    await h.runtime.executeCall(ctx(), call({ durationMinutes: 30, end: ARGS.end, start: ARGS.start }));
    await h.runtime.executeCall(ctx(), call(ARGS));
    expect(h.audit[0]!.argumentsSha256).toBe(h.audit[1]!.argumentsSha256);
  });
});

describe('authorization happens before any credential is touched', () => {
  const cases: [string, Parameters<typeof harness>[0], Partial<ToolExecutionContext>, string][] = [
    ['cross-org connection id', {}, { organizationId: ORG_B }, 'CONNECTION_NOT_FOUND'],
    ['directory that ignores the org filter', { directoryIgnoresOrg: true }, { organizationId: ORG_B }, 'CONNECTION_NOT_FOUND'],
    ['unknown connection', {}, { connectionId: 'aaaaaaaa-0000-4000-8000-0000000000ff' }, 'CONNECTION_NOT_FOUND'],
    ['provider mismatch (slack connection)', {}, { connectionId: CONN_SLACK }, 'PROVIDER_MISMATCH'],
    ['org policy disabled', { policyEnabled: false }, {}, 'POLICY_DISABLED'],
    ["someone else's personal connection", {}, { connectionId: CONN_PERSONAL }, 'NOT_GRANTED'],
    ['agent without a grant', { grants: new Set([`${CONN}|${USER_1}`]) }, { agentId: AGENT }, 'NOT_GRANTED'],
    ['user without a grant', { grants: new Set() }, {}, 'NOT_GRANTED'],
    ['expired connection', {}, { connectionId: CONN_EXPIRED }, 'REAUTHORIZATION_REQUIRED'],
    ['connection lacking a read scope', {}, { connectionId: CONN_NOSCOPE }, 'SCOPE_MISSING'],
  ];
  it.each(cases)('%s → %s', async (_label, over, c, code) => {
    const h = harness(over);
    const r = await h.runtime.executeCall(ctx(c), call());
    expect(r).toMatchObject({ ok: false, code });
    expect(h.tokenCalls).toBe(0);
    expect(h.googleCalls).toHaveLength(0);
    expect(h.audit.map((e) => e.outcome)).toEqual([code]);
  });

  it('the owner may use their personal connection', async () => {
    const h = harness();
    const r = await h.runtime.executeCall(ctx({ actorUserId: USER_2, connectionId: CONN_PERSONAL }), call());
    expect(r.ok).toBe(true);
    expect(h.googleCalls[0]!.auth).toBe('Bearer AT-3');
  });

  it('an injected admin/MCP tool name is UNKNOWN_TOOL and touches nothing', async () => {
    const h = harness();
    const r = await h.runtime.executeCall(ctx(), call({ cmd: 'id' }, 'admin_mcp_exec'));
    expect(r).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL', capability: null });
    expect(h.tokenCalls).toBe(0);
    expect(h.audit[0]).toMatchObject({ capability: null, outcome: 'UNKNOWN_TOOL' });
  });
});

describe('argument validation (untrusted model output)', () => {
  it.each([
    ['extra key', { ...ARGS, calendarId: 'someone-else@example.com' }],
    ['window too long', { ...ARGS, end: new Date(Date.parse(ARGS.start) + (MAX_AVAILABILITY_WINDOW_DAYS + 1) * 86_400_000).toISOString() }],
    ['window in the past', { ...ARGS, start: '2026-11-01T09:00:00Z', end: '2026-11-01T10:00:00Z' }],
    ['end before start', { ...ARGS, end: '2026-11-20T08:00:00Z' }],
    ['no offset', { ...ARGS, start: '2026-11-20T09:00:00' }],
    ['bad duration', { ...ARGS, durationMinutes: 3 }],
    ['fractional duration', { ...ARGS, durationMinutes: 30.5 }],
    ['bad time zone', { ...ARGS, timeZone: 'Mars/Olympus' }],
    ['limit too high', { ...ARGS, limit: 500 }],
  ])('%s → INVALID_ARGUMENTS without fetching a token', async (_l, args) => {
    const h = harness();
    const r = await h.runtime.executeCall(ctx(), call(args));
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(h.tokenCalls).toBe(0);
  });
});

describe('credential and provider failures', () => {
  it('a revoked connection (broker-side) → REAUTHORIZATION_REQUIRED, Google never called', async () => {
    const h = harness();
    const r = await h.runtime.executeCall(ctx({ connectionId: CONN_REVOKED }), call());
    expect(r).toMatchObject({ ok: false, code: 'REAUTHORIZATION_REQUIRED' });
    expect(h.tokenCalls).toBe(1);
    expect(h.googleCalls).toHaveLength(0);
  });

  it('Google 401 → REAUTHORIZATION_REQUIRED; 500 → PROVIDER_UNAVAILABLE; provider detail never reaches the model', async () => {
    for (const [status, code] of [[401, 'REAUTHORIZATION_REQUIRED'], [500, 'PROVIDER_UNAVAILABLE']] as const) {
      googleStatus = status;
      const h = harness();
      const r = await h.runtime.executeCall(ctx(), call());
      expect(r).toMatchObject({ ok: false, code });
      expect(r.content).not.toContain('internal google detail');
    }
  });
});

describe('turn execution', () => {
  it('executes multiple calls strictly serially, in order', async () => {
    const h = harness();
    const rs = await h.runtime.executeTurn(ctx(), [call(ARGS, undefined, 'a'), call(ARGS, undefined, 'b'), call(ARGS, undefined, 'c')]);
    expect(rs.map((r) => r.toolCallId)).toEqual(['a', 'b', 'c']);
    expect(h.maxInFlight).toBe(1);
  });

  it('enforces the per-turn call budget', async () => {
    const h = harness({ maxCallsPerTurn: 2 });
    const rs = await h.runtime.executeTurn(ctx(), [call(ARGS, undefined, 'a'), call(ARGS, undefined, 'b'), call(ARGS, undefined, 'c')]);
    expect(rs.map((r) => r.code ?? 'ok')).toEqual(['ok', 'ok', 'CALL_BUDGET_EXCEEDED']);
    expect(h.googleCalls).toHaveLength(2);
  });

  it('one refused call does not abort the others', async () => {
    const h = harness();
    const rs = await h.runtime.executeTurn(ctx(), [call({ bogus: 1 }, undefined, 'a'), call(ARGS, undefined, 'b')]);
    expect(rs.map((r) => r.ok)).toEqual([false, true]);
  });

  it('toToolMessages produces tool-role messages keyed by call id', async () => {
    const h = harness();
    const rs = await h.runtime.executeTurn(ctx(), [call()]);
    expect(ConnectToolRuntime.toToolMessages(rs)).toEqual([{ role: 'tool', toolCallId: 'call-1', content: rs[0]!.content }]);
  });
});

describe('runtime guards', () => {
  const fakeTool = (over: Partial<ConnectTool<Record<string, unknown>>>): ConnectTool<never> =>
    ({
      capability: 'test.cap',
      modelName: 'test_tool',
      provider: 'google',
      risk: 'read',
      acceptedScopes: [FREEBUSY],
      description: 'test',
      parameters: { type: 'object', properties: {} },
      validate: (raw: Record<string, unknown>) => ({ ok: true, value: raw }),
      execute: vi.fn(async () => ({ ok: true, data: {} })),
      ...over,
    }) as unknown as ConnectTool<never>;

  it('write-risk tools are refused with APPROVAL_REQUIRED before a token is fetched', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, data: {} }));
    const h = harness({ tools: [fakeTool({ risk: 'write', execute })] });
    const r = await h.runtime.executeCall(ctx(), call({}, 'test_tool'));
    expect(r).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
    expect(h.tokenCalls).toBe(0);
  });

  it('oversized output is replaced by OUTPUT_TOO_LARGE', async () => {
    const h = harness({ maxOutputBytes: 100, tools: [fakeTool({ execute: async () => ({ ok: true, data: 'x'.repeat(500) }) })] });
    expect(await h.runtime.executeCall(ctx(), call({}, 'test_tool'))).toMatchObject({ ok: false, code: 'OUTPUT_TOO_LARGE' });
  });

  it('a throwing handler becomes INTERNAL, not an exception', async () => {
    const h = harness({ tools: [fakeTool({ execute: async () => { throw new Error('boom with secret'); } })] });
    const r = await h.runtime.executeCall(ctx(), call({}, 'test_tool'));
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(r.content).not.toContain('secret');
  });

  it('an audit-sink failure does not break the call', async () => {
    const h = harness({ auditThrows: true });
    expect((await h.runtime.executeCall(ctx(), call())).ok).toBe(true);
  });

  it('rejects duplicate model names at construction', () => {
    expect(() => harness({ tools: [fakeTool({}), fakeTool({})] })).toThrow(/duplicate/);
  });

  it('offers only registered tools, in a shape the model adapter accepts', () => {
    const defs = harness().runtime.modelToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['calendar_find_availability']);
    expect(() => validateToolDefinitions(defs, 'langdock')).not.toThrow();
  });
});
