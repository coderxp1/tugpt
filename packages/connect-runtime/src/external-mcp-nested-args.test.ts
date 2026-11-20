/**
 * Agent 2 (MCP reliability): string-encoded nested arguments.
 *
 * Regression from the real-stack verification run (official @modelcontextprotocol/server-memory@2.2.1, TuGPT Scout):
 * the model's tool call for create_entities carried `entities` as a JSON STRING (Python json.dumps formatting,
 * `", "` / `": "` separators) instead of an array. The audit row's arguments_sha256 (5be08c724db4...) matches exactly
 * {"entities": "[{\"name\": \"Acme GmbH\", ...}]"}. Every nested-argument tool therefore failed with INVALID_ARGUMENTS
 * and could never be used.
 *
 * Contract:
 *  - Only where the APPROVED schema says a value must be an array or object (and does NOT also allow string) is a
 *    string value decoded with JSON.parse, and only if the decoded value has an allowed type. Anything else is left
 *    as-is, so the normal validation rejects it (fail closed).
 *  - The approval hash, the audit hash and the approval card stay on the arguments EXACTLY as the model sent them;
 *    the executed value is a deterministic function of exactly those approved arguments.
 *  - Decoding never bypasses the approval: a decoded write call without an approval is APPROVAL_REQUIRED.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ConnectToolRuntime, type ConnectToolRuntimeOptions } from './runtime.js';
import { createExternalMcpTool, type ExternalMcpFetch, type ExternalMcpToolDef } from './external-mcp-tool.js';
import * as J from './json-schema-args.js';
import type { ConnectTool, ToolAuditEvent, ToolExecutionContext } from './types.js';

const PUBLIC = async () => ['93.184.216.34'];

/** Exactly the inputSchema the official memory server publishes for create_entities (stored snapshot). */
const CREATE_ENTITIES: ExternalMcpToolDef = {
  name: 'create_entities',
  description: 'Create multiple new entities in the knowledge graph',
  inputSchema: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['entities'],
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'entityType', 'observations'],
          properties: {
            name: { type: 'string' },
            entityType: { type: 'string' },
            observations: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  permissionClass: 'write',
};

const ENTITY = { name: 'Acme GmbH', entityType: 'company', observations: ['Customer since 2026', 'Contact: Jana Weber'] };
/** Python json.dumps formatting, as observed from the model. */
const pyDumps = (v: unknown) => JSON.stringify(v).replace(/","/g, '", "').replace(/":/g, '": ').replace(/},\{/g, '}, {');

function memoryServer() {
  const calls: unknown[] = [];
  const fetchFn: ExternalMcpFetch = async (_u, init) => {
    const body = JSON.parse(init.body) as { id?: unknown; method: string; params?: { arguments?: unknown } };
    if (body.method === 'initialize') return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) };
    if (body.method === 'notifications/initialized') return { status: 202, text: async () => '' };
    calls.push(body.params?.arguments);
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'created' }] } }) };
  };
  return { calls, fetchFn };
}

const ctx: ToolExecutionContext = { organizationId: 'org1', actorUserId: 'user1', agentId: null, connectionId: 'conn1', requestId: 'req1' };
const canon = (v: unknown): string => (v === null || typeof v !== 'object') ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
const sha = (v: unknown) => createHash('sha256').update(canon(v)).digest('hex');

function harness(opts: { def?: ExternalMcpToolDef; claim?: boolean } = {}) {
  const server = memoryServer();
  const tool = createExternalMcpTool({ url: 'https://customer.example.com/mcp', fetchFn: server.fetchFn, resolveHostname: PUBLIC }, opts.def ?? CREATE_ENTITIES);
  const claims: { argumentsSha256: string }[] = [];
  const audits: ToolAuditEvent[] = [];
  const rt = new ConnectToolRuntime({
    tools: [tool as unknown as ConnectTool<never>],
    connections: { getConnection: async () => ({ id: 'conn1', organizationId: 'org1', ownerUserId: null, provider: 'mcp', status: 'connected', grantedScopes: [] }) },
    policy: { isCapabilityEnabled: async () => true },
    grants: { isGranted: async () => true },
    tokens: { getAccessToken: async () => ({ ok: true, value: { accessToken: '', expiresAt: 'x' } }) },
    audit: { record: async (e: ToolAuditEvent) => { audits.push(e); } },
    approvals: { claimApproval: async (a: { argumentsSha256: string }) => { claims.push(a); return opts.claim ?? true; } },
  } as unknown as ConnectToolRuntimeOptions);
  const call = (args: Record<string, unknown>) => rt.executeCall(ctx, { id: 'c1', name: tool.modelName, arguments: args });
  return { tool, call, server, claims, audits };
}

describe('string-encoded nested arguments (real Scout payload)', () => {
  it('the exact observed payload hashes to the audit row from the real run', () => {
    expect(sha({ entities: pyDumps([ENTITY]) }).slice(0, 12)).toBe('5be08c724db4');
  });

  it('entities as a JSON string -> decoded array reaches the server; approval + audit use the ORIGINAL arguments', async () => {
    const h = harness();
    const raw = { entities: pyDumps([ENTITY]) };
    const r = await h.call(raw);
    expect(r).toMatchObject({ ok: true });
    expect(h.server.calls).toEqual([{ entities: [ENTITY] }]);
    expect(h.claims).toHaveLength(1);
    expect(h.claims[0].argumentsSha256).toBe(sha(raw));
    expect(h.audits.map((a) => [a.outcome, a.argumentsSha256])).toEqual([['ok', sha(raw)]]);
  });

  it('a string-encoded array nested inside a real array is decoded too', async () => {
    const h = harness();
    const r = await h.call({ entities: [{ ...ENTITY, observations: JSON.stringify(ENTITY.observations) }] });
    expect(r).toMatchObject({ ok: true });
    expect(h.server.calls).toEqual([{ entities: [ENTITY] }]);
  });

  it('decoding never bypasses the per-call approval: no approval -> APPROVAL_REQUIRED, server not called', async () => {
    const h = harness({ claim: false });
    const r = await h.call({ entities: pyDumps([ENTITY]) });
    expect(r).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(h.server.calls).toHaveLength(0);
  });
});

describe('decoding fails closed', () => {
  const invalid = async (args: Record<string, unknown>, def?: ExternalMcpToolDef) => {
    const h = harness({ def });
    const r = await h.call(args);
    return { r, h };
  };

  it('string that decodes to the wrong type (object where an array is required) -> INVALID_ARGUMENTS, no claim', async () => {
    const { r, h } = await invalid({ entities: JSON.stringify(ENTITY) });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(h.claims).toHaveLength(0);
    expect(h.server.calls).toHaveLength(0);
  });

  it('string that is not JSON -> INVALID_ARGUMENTS with the normal detail', async () => {
    const { r, h } = await invalid({ entities: '[{"name": "Acme GmbH"' });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(JSON.parse(r.content).detail).toContain('entities: expected array');
    expect(h.claims).toHaveLength(0);
  });

  it('double-encoded (string of a string) is not unwrapped twice', async () => {
    const { r } = await invalid({ entities: JSON.stringify(JSON.stringify([ENTITY])) });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
  });

  it('a schema that also allows string keeps the string untouched', async () => {
    const def: ExternalMcpToolDef = { ...CREATE_ENTITIES, inputSchema: { type: 'object', properties: { entities: { type: ['string', 'array'] } } } };
    const h = harness({ def });
    const s = JSON.stringify([ENTITY]);
    const r = await h.call({ entities: s });
    expect(r).toMatchObject({ ok: true });
    expect(h.server.calls).toEqual([{ entities: s }]);
  });

  it('a property without a declared type keeps the string untouched', async () => {
    const def: ExternalMcpToolDef = { ...CREATE_ENTITIES, inputSchema: { type: 'object', properties: { entities: { description: 'anything' } } } };
    const h = harness({ def });
    const s = JSON.stringify([ENTITY]);
    await h.call({ entities: s });
    expect(h.server.calls).toEqual([{ entities: s }]);
  });

  it('strings longer than MAX_DECODE_CHARS are never parsed', async () => {
    const max = (J as unknown as { MAX_DECODE_CHARS?: number }).MAX_DECODE_CHARS;
    expect(typeof max).toBe('number');
    const big = JSON.stringify([{ ...ENTITY, observations: ['x'.repeat((max as number) + 10)] }]);
    const { r, h } = await invalid({ entities: big });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(h.server.calls).toHaveLength(0);
  });
});

describe('decodeStringEncodedJson (unit)', () => {
  const decode = (J as unknown as { decodeStringEncodedJson?: (s: unknown, v: unknown) => unknown }).decodeStringEncodedJson;
  it('is exported', () => { expect(typeof decode).toBe('function'); });
  it('does not mutate its input and leaves already-valid values equal', () => {
    const raw = { entities: pyDumps([ENTITY]) };
    const frozen = JSON.stringify(raw);
    const out = decode!(CREATE_ENTITIES.inputSchema, raw);
    expect(JSON.stringify(raw)).toBe(frozen);
    expect(out).toEqual({ entities: [ENTITY] });
    expect(decode!(CREATE_ENTITIES.inputSchema, { entities: [ENTITY] })).toEqual({ entities: [ENTITY] });
  });
  it('stops at MAX_SCHEMA_DEPTH instead of recursing without bound', () => {
    let schema: Record<string, unknown> = { type: 'array', items: { type: 'string' } };
    let value: unknown = ['x'];
    for (let i = 0; i < J.MAX_SCHEMA_DEPTH + 5; i++) { schema = { type: 'object', properties: { n: schema } }; value = { n: value }; }
    expect(() => decode!(schema, value)).not.toThrow();
  });
});
