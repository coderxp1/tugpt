import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GET as listGET, POST as createPOST } from './route';
import { PATCH as patchPATCH, DELETE as deleteDELETE } from './[entryId]/route';
import { POST as previewPOST } from './preview/route';

// --- Mocks ---
//
// The session client is a chainable PostgREST-shaped fake: every
// builder method returns the chain, the chain is thenable with the
// per-test terminal result, and `.single()` resolves its own
// configured result. @tugpt/database is mocked by SPREADING the
// real module so selectKnowledgeEntries — whose behavior the
// preview tests assert — is the production function, while the
// admin client (feature gate) is stubbed.

const mockAdminRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(() =>
    Promise.resolve({ from: mockFrom })
  ),
}));

vi.mock('@tugpt/database', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createAdminSupabaseClient: vi.fn(() => ({ rpc: mockAdminRpc })),
  };
});

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

interface ChainResult {
  data: unknown;
  error: unknown;
}

function makeChain(result: ChainResult, singleResult?: ChainResult) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'insert', 'update', 'delete']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(singleResult ?? result);
  chain.then = (
    resolve: (value: ChainResult) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const ORG = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const ENTRY_ID = '11111111-2222-3333-4444-555555555555';

function makeRequest(url: string, options?: RequestInit) {
  return new Request(`http://localhost${url}`, {
    headers: { 'x-tenant-id': ORG, ...options?.headers },
    ...options,
  });
}

function jsonRequest(url: string, method: string, payload: unknown) {
  return makeRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockResolveTenantContext.mockResolvedValue({ organizationId: ORG });
  mockAdminRpc.mockResolvedValue({ data: true, error: null });
});

const ENTRY = {
  id: ENTRY_ID,
  organization_id: ORG,
  question: '¿Cuál es el horario?',
  answer: 'Lunes a viernes, 9:00 a 18:00.',
  enabled: true,
  created_by: 'user-1',
  created_at: '2026-10-22T00:00:00.000Z',
  updated_at: '2026-10-22T00:00:00.000Z',
};

describe('knowledge routes', () => {
  it('GET lists the active organization’s entries, scoped by organization', async () => {
    const chain = makeChain({ data: [ENTRY], error: null });
    mockFrom.mockReturnValue(chain);

    const res = await listGET(makeRequest('/api/v1/knowledge'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
  });

  it('GET without a session is 401', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await listGET(makeRequest('/api/v1/knowledge'));
    expect(res.status).toBe(401);
  });

  it('GET with the feature gate closed is 503', async () => {
    mockAdminRpc.mockResolvedValue({ data: false, error: null });
    const res = await listGET(makeRequest('/api/v1/knowledge'));
    expect(res.status).toBe(503);
  });

  it('POST creates an entry stamped with the organization and the author', async () => {
    const chain = makeChain({ data: null, error: null }, { data: ENTRY, error: null });
    mockFrom.mockReturnValue(chain);

    const res = await createPOST(
      jsonRequest('/api/v1/knowledge', 'POST', {
        question: '¿Cuál es el horario?',
        answer: 'Lunes a viernes, 9:00 a 18:00.',
      })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.entry.id).toBe(ENTRY_ID);
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        created_by: 'user-1',
        enabled: true,
      })
    );
  });

  it('POST refuses blank and oversized content with 400', async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: null }));
    const blank = await createPOST(
      jsonRequest('/api/v1/knowledge', 'POST', { question: '  ', answer: 'x' })
    );
    expect(blank.status).toBe(400);

    const oversized = await createPOST(
      jsonRequest('/api/v1/knowledge', 'POST', {
        question: 'q',
        answer: 'a'.repeat(4001),
      })
    );
    expect(oversized.status).toBe(400);
  });

  it('POST maps an RLS refusal (agent role) to 403', async () => {
    mockFrom.mockReturnValue(
      makeChain({ data: null, error: null }, { data: null, error: { code: '42501' } })
    );
    const res = await createPOST(
      jsonRequest('/api/v1/knowledge', 'POST', { question: 'q', answer: 'a' })
    );
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('PATCH updates an entry and returns it', async () => {
    mockFrom.mockReturnValue(
      makeChain({ data: [{ ...ENTRY, enabled: false }], error: null })
    );
    const res = await patchPATCH(
      jsonRequest(`/api/v1/knowledge/${ENTRY_ID}`, 'PATCH', { enabled: false }),
      { params: Promise.resolve({ entryId: ENTRY_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.entry.enabled).toBe(false);
  });

  it('PATCH on an entry outside the tenant is the same 404 as a missing one', async () => {
    mockFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const res = await patchPATCH(
      jsonRequest(`/api/v1/knowledge/${ENTRY_ID}`, 'PATCH', { enabled: false }),
      { params: Promise.resolve({ entryId: ENTRY_ID }) }
    );
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('KNOWLEDGE_ENTRY_NOT_FOUND');
  });

  it('PATCH with a malformed id is 400 before any data access', async () => {
    const res = await patchPATCH(
      jsonRequest('/api/v1/knowledge/not-a-uuid', 'PATCH', { enabled: true }),
      { params: Promise.resolve({ entryId: 'not-a-uuid' }) }
    );
    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('DELETE removes the entry; a second delete is 404', async () => {
    mockFrom.mockReturnValue(makeChain({ data: [{ id: ENTRY_ID }], error: null }));
    const res = await deleteDELETE(makeRequest(`/api/v1/knowledge/${ENTRY_ID}`), {
      params: Promise.resolve({ entryId: ENTRY_ID }),
    });
    expect(res.status).toBe(200);

    mockFrom.mockReturnValue(makeChain({ data: [], error: null }));
    const again = await deleteDELETE(makeRequest(`/api/v1/knowledge/${ENTRY_ID}`), {
      params: Promise.resolve({ entryId: ENTRY_ID }),
    });
    expect(again.status).toBe(404);
  });

  it('preview selects with the production algorithm over enabled entries', async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: [
          { question: '¿Cuál es el horario?', answer: 'Lunes a viernes, 9 a 18.' },
          { question: '¿Hacen envíos?', answer: 'Sí, a todo el país.' },
        ],
        error: null,
      })
    );
    const res = await previewPOST(
      jsonRequest('/api/v1/knowledge/preview', 'POST', {
        question: '¿Cuál es el horario de atención?',
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.selected).toHaveLength(1);
    expect(body.selected[0].question).toBe('¿Cuál es el horario?');
  });

  it('preview with no matching entry returns an empty selection — the no-knowledge path', async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: [{ question: '¿Cuál es el horario?', answer: 'Lunes a viernes.' }],
        error: null,
      })
    );
    const res = await previewPOST(
      jsonRequest('/api/v1/knowledge/preview', 'POST', {
        question: '¿Tienen estacionamiento para bicicletas?',
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.selected).toEqual([]);
  });
});
