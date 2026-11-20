import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_ROUTES, canManageConnections, oauthBanner, oauthReturnQuery, parseOAuthReturn, usable } from './contract';
import { routeAvailability } from './routes.server';
import { pickerBlock, requestProblem, toolProblem } from './chat-errors';
import { mcpIssue, mcpProblem, validateEndpointInput } from './mcp';
import { createTranslator } from '@/i18n';
import { postJson } from './http';

describe('OAuth return parsing', () => {
  it('accepts the documented callback outcomes', () => {
    expect(parseOAuthReturn({ google: 'connected' })).toEqual({ provider: 'google', outcome: 'connected' });
    expect(parseOAuthReturn({ microsoft: 'error', reason: 'forbidden' })).toEqual({ provider: 'microsoft', outcome: 'error', reason: 'forbidden' });
    expect(parseOAuthReturn({ google: 'revoked' })).toEqual({ provider: 'google', outcome: 'revoked' });
  });
  it('never passes unknown values through', () => {
    expect(parseOAuthReturn({ google: '<script>' })).toBeNull();
    expect(parseOAuthReturn({ google: 'error', reason: 'javascript:alert(1)' })).toEqual({ provider: 'google', outcome: 'error', reason: 'unknown' });
    expect(parseOAuthReturn({ google: ['connected', 'x'] })).toBeNull();
    expect(oauthReturnQuery({ microsoft: 'error', reason: 'x"><img>', next: 'https://evil.example' })).toBe('?microsoft=error&reason=unknown');
    expect(oauthReturnQuery({ next: '/x' })).toBe('');
  });
  it('words every outcome for people, never as raw codes', () => {
    for (const reason of ['invalid_callback', 'forbidden', 'not_configured', 'internal_error', 'provider_error', 'disconnect_failed', 'unknown'] as const) {
      const b = oauthBanner({ provider: 'google', outcome: 'error', reason });
      expect(b.tone).toBe('error'); expect(b.body).not.toMatch(/_/);
    }
    expect(oauthBanner({ provider: 'microsoft', outcome: 'connected' })).toMatchObject({ tone: 'ok', title: 'Microsoft 365 is connected' });
  });
  it('lets only owners and admins manage connections', () => {
    expect(['owner', 'admin', 'manager', 'agent', 'viewer', null].map(canManageConnections)).toEqual([true, true, false, false, false, false]);
  });
});

describe('routeAvailability', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'manifest-'));
  it('marks routes present in the build manifest as available, others missing', () => {
    const f = path.join(dir, 'm.json');
    writeFileSync(f, JSON.stringify({ [CONTRACT_ROUTES.googleStart]: 'app/x.js', '/api/v1/chat/threads/route': 'y' }));
    const r = routeAvailability(f);
    expect(r.googleStart).toBe('available');
    expect(r.microsoftStart).toBe('missing');
    expect(usable(r.microsoftStart)).toBe(false);
  });
  it('reports unknown (and stays usable, routes fail closed) when the manifest cannot be read', () => {
    const r = routeAvailability(path.join(dir, 'nope.json'));
    expect(Object.values(r).every((v) => v === 'unknown')).toBe(true);
    expect(usable(r.googleStart)).toBe(true);
  });
});

describe('chat problems', () => {
  const codes = ['NOT_GRANTED', 'POLICY_DISABLED', 'SCOPE_MISSING', 'APPROVAL_REQUIRED', 'PROVIDER_MISMATCH', 'CONNECTION_NOT_FOUND', 'CONNECTION_NOT_ACTIVE', 'REAUTHORIZATION_REQUIRED', 'PROVIDER_UNAVAILABLE', 'UNKNOWN_TOOL'];
  it('has a specific human message for every runtime tool error code', () => {
    const generic = toolProblem('SOMETHING_ELSE').text;
    for (const c of codes) { expect(toolProblem(c).text).not.toBe(generic); expect(toolProblem(c).text).not.toContain(c); }
    expect(toolProblem('REAUTHORIZATION_REQUIRED').connect).toBe(true);
    expect(toolProblem('POLICY_DISABLED').connect).toBe(false);
  });
  it('maps the messages route 409s', () => {
    expect(requestProblem('An attached integration is not connected')).toMatchObject({ connect: true });
    expect(requestProblem('This model cannot use integrations').text).toContain('tool-calling verification');
    expect(requestProblem(undefined).text).toBe('The message could not be sent.');
  });
  it('blocks picker entries with the reason, in priority order', () => {
    expect(pickerBlock({ state: 'connected', toolAvailable: true }, true)).toBeNull();
    expect(pickerBlock({ state: 'connected', toolAvailable: true }, false)).toMatch(/model/);
    expect(pickerBlock({ state: 'connected', toolAvailable: false }, true)).toBe('Not available in chat yet');
    expect(pickerBlock({ state: 'requires_connection', toolAvailable: true }, true)).toBe('Connect first');
    expect(pickerBlock({ state: 'disabled_by_policy' }, true)).toBe('Turned off by your organization');
  });
});

describe('MCP input and errors', () => {
  it('validates endpoint input before sending', () => {
    expect(validateEndpointInput('https://mcp.example.com/sse', 'Docs')).toBeNull();
    expect(validateEndpointInput('http://mcp.example.com', 'Docs')).toMatch(/https/);
    expect(validateEndpointInput('https://u:p@mcp.example.com', 'Docs')).toMatch(/password/);
    expect(validateEndpointInput('https://mcp.example.com', ' ')).toMatch(/name/);
  });
  it('explains activation denials and security holds', () => {
    expect(mcpProblem({ ok: false, status: 409, code: 'ACTIVATION_DENIED', message: 'snapshot not approved' })).toMatch(/refused to switch this server on.*approve the new list/);
    const issue = mcpIssue({ ok: false, status: 409, code: 'ACTIVATION_DENIED', message: 'snapshot not approved' });
    expect(issue).toMatchObject({ text: expect.stringContaining('refused'), fix: expect.stringContaining('Discover'), detail: 'snapshot not approved' });
    expect(mcpIssue({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Customer MCP is not enabled' }).detail).toBeUndefined();
    const es = mcpIssue({ ok: false, status: 504, code: 'DISCOVERY_TIMEOUT', message: '' }, createTranslator('es'));
    expect(es.text).not.toBe(mcpIssue({ ok: false, status: 504, code: 'DISCOVERY_TIMEOUT', message: '' }).text);
    expect(es.fix).toBeTruthy();
    expect(mcpProblem({ ok: false, status: 503, code: 'privileged_bridge_pending_review', message: '' })).toMatch(/security review/);
  });
  it('normalises both error shapes', async () => {
    const f = (body: unknown, status: number) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await postJson('/x', {}, f({ error: { code: 'FORBIDDEN', message: 'no' } }, 403))).toEqual({ ok: false, status: 403, code: 'FORBIDDEN', message: 'no' });
    expect(await postJson('/x', {}, f({ error: 'privileged_bridge_pending_review' }, 503))).toMatchObject({ code: 'privileged_bridge_pending_review' });
    expect(await postJson('/x', {}, f({ a: 1 }, 201))).toEqual({ ok: true, data: { a: 1 } });
  });
});
