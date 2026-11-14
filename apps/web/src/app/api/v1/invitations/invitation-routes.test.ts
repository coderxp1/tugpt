/**
 * @file invitation-routes.test.ts
 * @description The three invitation routes.
 *
 * The database owns every authorization rule here — who may invite, at what
 * role, whether the address is already a member, whether a token matches.
 * These prove the routes do not re-implement any of it, do not let a caller
 * talk them out of it, and do not leak the one secret the flow produces.
 *
 * The token assertions are the ones that matter. A token that reaches a log
 * is a token an operator can use to join an organization as somebody else,
 * and nothing about that failure is visible from reading the happy path.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { POST as createPOST, GET as listGET } from './route';
import { POST as revokePOST } from './[invitationId]/revoke/route';
import { POST as acceptPOST } from './accept/route';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(() => Promise.resolve({ rpc: mockRpc, from: mockFrom })),
}));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return { getCurrentUser: mockGetCurrentUser, resolveTenantContext: mockResolveTenantContext };
  }),
}));

const logged: unknown[] = [];
vi.mock('@tugpt/observability', () => ({
  defaultLogger: {
    info: (...a: unknown[]) => logged.push(a),
    warn: (...a: unknown[]) => logged.push(a),
    error: (...a: unknown[]) => logged.push(a),
  },
}));

const ORG = 'org-1';
const USER = 'bbbbbbbb-1111-1111-1111-111111111111';
const INV = 'aaaaaaaa-1111-1111-1111-111111111111';
const TOKEN = 'f'.repeat(64);

function setup(opts: { rpcError?: unknown; rpcData?: unknown; role?: string } = {}) {
  vi.clearAllMocks();
  logged.length = 0;
  mockGetCurrentUser.mockResolvedValue({ id: USER, email: 'owner@acme.test' });
  mockResolveTenantContext.mockResolvedValue({
    organizationId: ORG,
    organizationName: 'Panadería La Espiga',
    role: opts.role ?? 'owner',
  });
  mockRpc.mockResolvedValue({
    data: opts.rpcData ?? {
      invitation_id: INV,
      token: TOKEN,
      email: 'nuevo@acme.test',
      role: 'agent',
      expires_at: '2026-09-09T00:00:00.000Z',
    },
    error: opts.rpcError ?? null,
  });
}

function req(body: unknown, url = 'http://localhost/api/v1/invitations') {
  return new Request(url, {
    method: 'POST',
    headers: { 'x-tenant-id': ORG, 'content-type': 'application/json', origin: 'https://dashboard.example', 'x-tugpt-csrf': '1' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const params = (id = INV) => ({ params: Promise.resolve({ invitationId: id }) });

async function create(body: unknown) {
  const res = await createPOST(req(body));
  return { res, body: await res.json() };
}
async function revoke(id = INV) {
  const res = await revokePOST(req({}, `http://localhost/api/v1/invitations/${id}/revoke`), params(id));
  return { res, body: await res.json() };
}
async function accept(body: unknown) {
  const res = await acceptPOST(req(body, 'http://localhost/api/v1/invitations/accept'));
  return { res, body: await res.json() };
}

beforeEach(() => setup());

describe('create — what reaches the database', () => {
  it('T1: passes the active organization, not one from the body', async () => {
    // The organization comes from the resolved session. Taking it from the
    // body would let any owner invite into any organization whose id they can
    // guess, and the RPC would have no way to tell the difference.
    await create({ email: 'nuevo@acme.test', role: 'agent' });

    expect(mockRpc).toHaveBeenCalledWith('create_invitation', {
      p_organization_id: ORG,
      p_email: 'nuevo@acme.test',
      p_role: 'agent',
    });
  });

  it('rejects body-supplied organization before any invitation RPC', async () => {
    const { res } = await create({ email: 'nuevo@acme.test', role: 'agent', organizationId: 'somebody-elses-org' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T2: does not check the caller\'s role itself', async () => {
    // A viewer's request still reaches the RPC, which refuses it with P3D02.
    // A duplicate check here would be a second copy of an authorization rule.
    setup({ role: 'viewer' });
    await create({ email: 'nuevo@acme.test', role: 'agent' });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('T3: passes owner through rather than rejecting it locally', async () => {
    // An owner inviting a co-owner is legitimate. The rank rule lives in the
    // RPC, which raises P3D08 for anyone below owner; refusing owner here
    // would put half of one rule in two places.
    await create({ email: 'nuevo@acme.test', role: 'owner' });
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_role: 'owner' });
  });
});

describe('create — the token', () => {
  it('T4: returns the token, because this is the only time it exists', async () => {
    const { res, body } = await create({ email: 'nuevo@acme.test', role: 'agent' });
    expect(res.status).toBe(201);
    expect(body.invitation.token).toBe(TOKEN);
  });

  it('T5: never writes the token to a log', async () => {
    // THE ONE THAT MATTERS. A token in a log is a credential an operator can
    // use to join an organization as somebody else, and it would sit there
    // looking like ordinary structured logging.
    await create({ email: 'nuevo@acme.test', role: 'agent' });

    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  it('T6: never writes the invitee\'s address to a log either', async () => {
    await create({ email: 'nuevo@acme.test', role: 'agent' });
    expect(JSON.stringify(logged)).not.toContain('nuevo@acme.test');
  });

  it('T7: a refusal logs no token and no address', async () => {
    setup({ rpcError: { code: 'P3D03' } });
    await create({ email: 'nuevo@acme.test', role: 'agent' });
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('nuevo@acme.test');
  });
});

describe('create — what it refuses', () => {
  it('T8: an unknown role is refused before the database', async () => {
    for (const role of ['superuser', '', 42, null, undefined, {}]) {
      setup();
      const { res } = await create({ email: 'a@b.test', role });
      expect(res.status, JSON.stringify(role ?? null)).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('T9: a missing or non-string email is refused', async () => {
    for (const email of [undefined, '', '   ', 42, null, []]) {
      setup();
      const { res } = await create({ email, role: 'agent' });
      expect(res.status, JSON.stringify(email ?? null)).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('T10: a malformed address is left to the database, not guessed at here', async () => {
    // "Looks like an email" is a rule with a thousand edge cases. The RPC has
    // one definition of it (P3D09); a second regex here would disagree with
    // it eventually, and the disagreement would be silent.
    setup({ rpcError: { code: 'P3D09' } });
    const { res, body } = await create({ email: 'not-an-email', role: 'agent' });
    expect(mockRpc).toHaveBeenCalled();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('INVALID_EMAIL');
  });

  it('T11: invalid JSON is a 400, not a 500', async () => {
    const { res } = await create('{oh no');
    expect(res.status).toBe(400);
  });
});

describe('how database refusals surface', () => {
  const cases: Array<[string, number, string]> = [
    ['P3D01', 404, 'INVITATION_NOT_FOUND'],
    ['P3D02', 403, 'FORBIDDEN'],
    ['P3D03', 409, 'INVITATION_ALREADY_PENDING'],
    ['P3D07', 409, 'ALREADY_A_MEMBER'],
    ['P3D08', 403, 'ROLE_ABOVE_YOUR_OWN'],
  ];

  for (const [sqlstate, status, code] of cases) {
    it(`T12/${sqlstate}: becomes ${status} ${code}`, async () => {
      setup({ rpcError: { code: sqlstate } });
      const { res, body } = await create({ email: 'a@b.test', role: 'agent' });
      expect(res.status).toBe(status);
      expect(body.error.code).toBe(code);
    });
  }

  it('T13: an unknown SQLSTATE is a 500 with no database text', async () => {
    setup({ rpcError: { code: '42P01', message: 'relation "organization_invitations" does not exist' } });
    const { res, body } = await create({ email: 'a@b.test', role: 'agent' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('relation');
  });
});

describe('revoke', () => {
  it('T14: passes the id through unchanged', async () => {
    setup({ rpcData: { invitation_id: INV, status: 'revoked' } });
    await revoke();
    expect(mockRpc).toHaveBeenCalledWith('revoke_invitation', { p_invitation_id: INV });
  });

  it('T15: a non-UUID never reaches the database', async () => {
    const { res } = await revoke('not-a-uuid');
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T16: another organization\'s invitation is 404, not 403', async () => {
    // The RPC answers "not found" for both a missing invitation and one in
    // another tenant, so ids cannot be probed. The route must not helpfully
    // upgrade that into a 403, which would restore the distinction.
    setup({ rpcError: { code: 'P3D01' } });
    const { res, body } = await revoke();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('T17: revoking a non-pending invitation is 409', async () => {
    setup({ rpcError: { code: 'P3D04' } });
    const { res, body } = await revoke();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('INVITATION_NOT_PENDING');
  });
});

describe('accept', () => {
  const okAccept = { organization_id: ORG, membership_created: true, role: 'agent' };

  it('T18: sends the plaintext token', async () => {
    setup({ rpcData: okAccept });
    await accept({ token: TOKEN });
    expect(mockRpc).toHaveBeenCalledWith('accept_invitation', { p_token: TOKEN });
  });

  it('T19: needs no active organization, because the caller is not in one yet', async () => {
    // Every other route resolves a tenant first. This one cannot: the invitee
    // is joining an organization they are not a member of, so there is nothing
    // to resolve. Requiring one would make the flow impossible for exactly the
    // people it exists for.
    setup({ rpcData: okAccept });
    mockResolveTenantContext.mockResolvedValue(null);

    const { res } = await accept({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalled();
  });

  it('T20: still requires a session', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    const { res } = await accept({ token: TOKEN });
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T21: reports the role actually held, not the invited one', async () => {
    // Already an agent, invited as admin: the membership is untouched and the
    // response says `agent`. Echoing the invited role would put a permission
    // set on screen that the database will not honour.
    setup({ rpcData: { organization_id: ORG, membership_created: false, role: 'agent' } });
    const { body } = await accept({ token: TOKEN });
    expect(body.membership.role).toBe('agent');
    expect(body.membership.membership_created).toBe(false);
  });

  it('T22: an expired invitation is 410, distinct from a bad token', async () => {
    // 410 tells the invitee to ask for a new one. 404 would send them looking
    // for a typo in a link that was correct.
    setup({ rpcError: { code: 'P3D05' } });
    const { res, body } = await accept({ token: TOKEN });
    expect(res.status).toBe(410);
    expect(body.error.code).toBe('INVITATION_EXPIRED');
  });

  it('T23: a token issued to another address is 403 with actionable wording', async () => {
    setup({ rpcError: { code: 'P3D06' } });
    const { res, body } = await accept({ token: TOKEN });
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('INVITATION_WRONG_ACCOUNT');
  });

  it('T24: a missing token is refused before the database', async () => {
    for (const token of [undefined, '', '   ', 42, null]) {
      setup();
      const { res } = await accept({ token });
      expect(res.status, JSON.stringify(token ?? null)).toBe(400);
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('T25: a rejected token is never logged', async () => {
    // A failed attempt is exactly when a token is most likely to be logged
    // "for debugging", and exactly when it is still live.
    setup({ rpcError: { code: 'P3D01' } });
    await accept({ token: TOKEN });
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });
});

describe('list', () => {
  function listClient(rows: unknown[]) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
    };
    mockFrom.mockReturnValue(chain);
    return chain;
  }

  it('T26: never selects token_hash', async () => {
    // Not a usable credential, but the one column that would let anyone with
    // response or log access confirm a guessed token offline. No screen needs
    // it, so it is not on the wire.
    setup();
    const chain = listClient([]);
    await listGET(new Request('http://localhost/api/v1/invitations', { headers: { 'x-tenant-id': ORG } }));

    const selected = chain.select.mock.calls[0][0] as string;
    expect(selected).not.toContain('token_hash');
    expect(selected).toContain('status');
  });

  it('T27: scopes to the active organization', async () => {
    setup();
    const chain = listClient([]);
    await listGET(new Request('http://localhost/api/v1/invitations', { headers: { 'x-tenant-id': ORG } }));
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
  });

  it('T28: 401 without a session', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await listGET(new Request('http://localhost/api/v1/invitations'));
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// Verified identity is a new explicit contract, not an internal server error.
it('maps unverified invitation identity to a stable 403', async () => {
  setup({ rpcError: { code: 'P3D10' } });
  const { POST } = await import('./accept/route');
  const response = await POST(new Request('http://localhost/api/v1/invitations/accept', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dashboard.example', 'x-tugpt-csrf': '1' }, body: JSON.stringify({ token: TOKEN }),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'VERIFIED_EMAIL_REQUIRED' } });
});

// Synthetic unit fixture only; no host or network configuration is changed.
beforeEach(() => vi.stubEnv('TUGPT_APP_ORIGIN', 'https://dashboard.example'));
afterEach(() => vi.unstubAllEnvs());
