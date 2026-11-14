/**
 * @file assignment-routes.test.ts
 * @description POST /assign and POST /handoff — the two write routes of the
 * Sep 25 handoff milestone.
 *
 * The database owns the rules: who may act, whether the assignee is a member,
 * and whether the transition is legal. These prove the route does not
 * re-implement any of that, does not let a caller talk it out of the
 * compare-and-set, and does not put a customer's number on the wire.
 *
 * `handoff` gets the sharper treatment of the two, because it is the switch
 * that stops the AI drafting for a customer.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { POST as assignPOST } from './assign/route';
import { POST as handoffPOST } from './handoff/route';

const mockRpc = vi.fn();
const mockFeatureRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createFeatureServerClient: vi.fn(async () => ({ rpc: mockFeatureRpc })),
  createAuthenticatedServerClient: vi.fn(() => Promise.resolve({ rpc: mockRpc, from: vi.fn() })),
}));

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => { throw new Error('Privileged transport forbidden'); }),
}));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: mockGetCurrentUser,
      resolveTenantContext: mockResolveTenantContext,
    };
  }),
}));

const CONV_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
const USER_ID = 'bbbbbbbb-1111-1111-1111-111111111111';
const OTHER_ID = 'cccccccc-1111-1111-1111-111111111111';
const ORG_ID = 'org-1';

function setup(opts: { gateOpen?: boolean; rpcError?: unknown; rpcData?: unknown } = {}) {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'reviewer@example.com' });
  mockResolveTenantContext.mockResolvedValue({
    organizationId: ORG_ID,
    organizationName: 'Panadería La Espiga',
    role: 'agent',
  });
  mockFeatureRpc.mockResolvedValue({ data: opts.gateOpen ?? true, error: null });
  mockRpc.mockResolvedValue({
    data: opts.rpcData ?? { conversation_id: CONV_ID, status: 'open', assigned_to: USER_ID },
    error: opts.rpcError ?? null,
  });
}

function req(body: unknown) {
  return new Request(`http://localhost/api/v1/conversations/${CONV_ID}/assign`, {
    method: 'POST',
    headers: { 'x-tenant-id': ORG_ID, 'content-type': 'application/json', origin: 'https://dashboard.example', 'x-tugpt-csrf': '1' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const params = (id = CONV_ID) => ({ params: Promise.resolve({ conversationId: id }) });

async function assign(body: unknown, id = CONV_ID) {
  const res = await assignPOST(req(body), params(id));
  return { res, body: await res.json() };
}

async function handoff(body: unknown, id = CONV_ID) {
  const res = await handoffPOST(req(body), params(id));
  return { res, body: await res.json() };
}

beforeEach(() => setup());

describe('assign — what reaches the database', () => {
  it('T1: passes the expectation through unchanged', async () => {
    await assign({ assignee: USER_ID, expectedAssignee: null });

    expect(mockRpc).toHaveBeenCalledWith('assign_conversation', {
      p_conversation_id: CONV_ID,
      p_assignee: USER_ID,
      p_expected_assignee: null,
    });
  });

  it('T2: releasing is assignee null, not a separate verb', async () => {
    await assign({ assignee: null, expectedAssignee: USER_ID });

    expect(mockRpc.mock.calls[0][1]).toMatchObject({
      p_assignee: null,
      p_expected_assignee: USER_ID,
    });
  });

  it('T3: does not check membership or role itself', async () => {
    // The RPC derives the org from the locked row and checks both. A second
    // copy here is a second thing to get wrong, and the two would drift.
    await assign({ assignee: OTHER_ID, expectedAssignee: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('assign — what it refuses', () => {
  it('T4: a missing expectedAssignee is refused, not defaulted to null', async () => {
    // THE ONE THAT MATTERS. Defaulting would read as "I saw it unassigned",
    // which is the value most likely to be wrong and the one that silently
    // wins a race between two reviewers.
    const { res, body } = await assign({ assignee: USER_ID });

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_BODY');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T5: an assignee that is not a UUID or null is refused', async () => {
    for (const value of ['not-a-uuid', 42, {}, [], true]) {
      setup();
      const { res } = await assign({ assignee: value, expectedAssignee: null });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('T6: a non-UUID expectedAssignee is refused', async () => {
    const { res } = await assign({ assignee: null, expectedAssignee: 'nope' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T7: a conversation id that is not a UUID never reaches the database', async () => {
    const { res } = await assign({ assignee: null, expectedAssignee: null }, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T8: invalid JSON is a 400, not a 500', async () => {
    const { res } = await assign('{oh no');
    expect(res.status).toBe(400);
  });
});

describe('assign — how database refusals surface', () => {
  it('T9: a conflict is 409, in words a reviewer can act on', async () => {
    setup({ rpcError: { code: 'P3C04' } });
    const { res, body } = await assign({ assignee: USER_ID, expectedAssignee: null });

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('ASSIGNMENT_CONFLICT');
  });

  it('T10: assigning outside the organization is 422', async () => {
    setup({ rpcError: { code: 'P3C03' } });
    const { res, body } = await assign({ assignee: OTHER_ID, expectedAssignee: null });

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('ASSIGNEE_NOT_A_MEMBER');
  });

  it('T11: a non-member is told 404, not 403', async () => {
    // The RPC deliberately answers "not found" rather than "forbidden" so that
    // an authenticated stranger cannot probe which ids exist in other tenants.
    // The route must not helpfully upgrade that into a 403.
    setup({ rpcError: { code: 'P3C01' } });
    const { res, body } = await assign({ assignee: USER_ID, expectedAssignee: null });

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('T12: a viewer is 403', async () => {
    setup({ rpcError: { code: 'P3C02' } });
    const { res } = await assign({ assignee: USER_ID, expectedAssignee: null });
    expect(res.status).toBe(403);
  });

  it('T13: an unknown SQLSTATE is a 500 with no database text', async () => {
    setup({ rpcError: { code: '42P01', message: 'relation "conversations" does not exist' } });
    const { res, body } = await assign({ assignee: USER_ID, expectedAssignee: null });

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('relation');
  });
});

describe('handoff — the kill switch', () => {
  it('T14: handing off asks for needs_human', async () => {
    await handoff({ needsHuman: true, expectedStatus: 'open' });

    expect(mockRpc).toHaveBeenCalledWith('set_conversation_handoff', {
      p_conversation_id: CONV_ID,
      p_needs_human: true,
      p_expected_status: 'open',
    });
  });

  it('T15: returning to the AI asks for the opposite', async () => {
    await handoff({ needsHuman: false, expectedStatus: 'needs_human' });
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_needs_human: false });
  });

  it('T16: needsHuman must be a boolean — "false" must not turn the AI off', async () => {
    // A string is what a form field sends. Truthiness here would read `"false"`
    // as true and switch AI drafting OFF for a customer while the reviewer
    // believed they were switching it on.
    for (const value of ['false', 'true', 0, 1, null, undefined]) {
      setup();
      const { res } = await handoff({ needsHuman: value, expectedStatus: 'open' });
      expect(res.status, JSON.stringify(value ?? null)).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('T17: a missing or unknown expectedStatus is refused', async () => {
    for (const body of [
      { needsHuman: true },
      { needsHuman: true, expectedStatus: 'archived' },
      { needsHuman: true, expectedStatus: 7 },
    ]) {
      setup();
      const { res } = await handoff(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('T18: "closed" is a legal expectation and the database refuses the transition', async () => {
    // Deliberate split: the route does not know that closed conversations
    // cannot be handed off. That rule lives in the RPC, once.
    setup({ rpcError: { code: 'P3C05' } });
    const { res, body } = await handoff({ needsHuman: true, expectedStatus: 'closed' });

    expect(mockRpc).toHaveBeenCalled();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('T19: a stale expected status is a 409', async () => {
    setup({ rpcError: { code: 'P3C04' } });
    const { res, body } = await handoff({ needsHuman: true, expectedStatus: 'open' });

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('ASSIGNMENT_CONFLICT');
  });
});

describe('both routes — the gate and the session', () => {
  it('T20: 401 without a user, and nothing reaches the database', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await assign({ assignee: null, expectedAssignee: null })).res.status).toBe(401);
    expect((await handoff({ needsHuman: true, expectedStatus: 'open' })).res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T21: 403 without an active organization', async () => {
    setup();
    mockResolveTenantContext.mockResolvedValue(null);
    expect((await assign({ assignee: null, expectedAssignee: null })).res.status).toBe(403);
    expect((await handoff({ needsHuman: true, expectedStatus: 'open' })).res.status).toBe(403);
  });

  it('T22: both refuse when the feature gate is closed, before touching the row', async () => {
    setup({ gateOpen: false });
    expect((await assign({ assignee: null, expectedAssignee: null })).res.status).toBe(503);
    setup({ gateOpen: false });
    expect((await handoff({ needsHuman: true, expectedStatus: 'open' })).res.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T23: neither response carries a contact number', async () => {
    setup({
      rpcData: { conversation_id: CONV_ID, status: 'needs_human', assigned_to: null },
    });
    const { body } = await handoff({ needsHuman: true, expectedStatus: 'open' });

    expect(JSON.stringify(body)).not.toMatch(/\+\d{7,}/);
    expect(JSON.stringify(body)).not.toContain('contact_phone');
  });
});

// Synthetic unit fixture only; no host or network configuration is changed.
beforeEach(() => vi.stubEnv('TUGPT_APP_ORIGIN', 'https://dashboard.example'));
afterEach(() => vi.unstubAllEnvs());
