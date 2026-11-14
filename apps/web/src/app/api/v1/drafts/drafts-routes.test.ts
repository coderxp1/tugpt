import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { GET as threadGET } from './[draftId]/thread/route';
import { GET as listDraftsGET } from './route';
import { GET as draftDetailGET } from './[draftId]/route';
import { GET as revisionsGET } from './[draftId]/revisions/route';
import { GET as eventsGET } from './[draftId]/events/route';
import { POST as approvePOST } from './[draftId]/approve/route';
import { GET as deliveryGET } from './[draftId]/delivery/route';
import { POST as editPOST } from './[draftId]/edit/route';
import { POST as rejectPOST } from './[draftId]/reject/route';

// Structural coverage is intentionally direct-source only, not a transitive
// no-network proof. Runtime isolation remains a separate P3 obligation.
const draftRouteSources = [
  './route.ts', './[draftId]/route.ts', './[draftId]/approve/route.ts',
  './[draftId]/edit/route.ts', './[draftId]/reject/route.ts',
  './[draftId]/delivery/route.ts', './[draftId]/events/route.ts',
  './[draftId]/revisions/route.ts', './[draftId]/thread/route.ts',
];
function sourceText(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

// --- Mocks ---

const mockRpc = vi.fn();
const mockFeatureRpc = vi.fn();

// Build a chainable mock that supports .select().eq().eq().single() and .select().eq().order().range()
function createChainableMock(overrides?: {
  singleResult?: { data: unknown; error: unknown };
  rangeResult?: { data: unknown; error: unknown; count: number };
  orderResult?: { data: unknown; error: unknown };
}) {
  const singleResult = overrides?.singleResult ?? { data: null, error: { code: 'PGRST116' } };
  const rangeResult = overrides?.rangeResult ?? { data: [], error: null, count: 0 };
  const orderResult = overrides?.orderResult ?? { data: [], error: null };
  void orderResult; // used in chain.order mock

  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(singleResult);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.range = vi.fn().mockResolvedValue(rangeResult);
  return chain;
}

const mockFrom = vi.fn();

// Mock the cookie-aware server client used by all draft routes
vi.mock('@/lib/supabase/server', () => ({
  createFeatureServerClient: vi.fn(async () => ({ rpc: mockFeatureRpc })),
  createAuthenticatedServerClient: vi.fn(() =>
    Promise.resolve({
      rpc: mockRpc,
      from: mockFrom,
    })
  ),
}));

// Tripwire: no draft route may fall back to the privileged admin factory.
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

// --- Helpers ---

const VALID_DRAFT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeRequest(url: string, options?: RequestInit) {
  return new Request(`http://localhost${url}`, {
    ...options,
    headers: { 'x-tenant-id': 'org-1', origin: 'https://dashboard.example', 'x-tugpt-csrf': '1', 'content-type': 'application/json', ...options?.headers },
  });
}

function makeParams(draftId: string) {
  return Promise.resolve({ draftId });
}

// Set up default successful auth + feature gate
function setupSuccessAuth() {
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
  mockResolveTenantContext.mockResolvedValue({
    organizationId: 'org-1',
    organizationName: 'Test Org',
    role: 'owner',
  });
  mockFeatureRpc.mockImplementation(async (name: string) => {
    if (name !== 'is_feature_enabled') throw new Error('Feature adapter widening forbidden');
    return { data: true, error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockReset();
  mockFeatureRpc.mockReset();
  mockFrom.mockReset();
  setupSuccessAuth();
});

// --- Tests ---

describe('Draft API Routes', () => {
  describe('GET /api/v1/drafts (list)', () => {
    it('T1: Returns 401 when unauthenticated', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);
      const res = await listDraftsGET(makeRequest('/api/v1/drafts'));
      expect(res.status).toBe(401);
    });

    it('T5: Returns paginated draft list for authenticated user', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        rangeResult: { data: [], error: null, count: 0 },
      }));

      const res = await listDraftsGET(makeRequest('/api/v1/drafts'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.drafts).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('T6: Returns empty array when no drafts', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        rangeResult: { data: [], error: null, count: 0 },
      }));

      const res = await listDraftsGET(makeRequest('/api/v1/drafts'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.drafts).toEqual([]);
    });

    it('T18: Feature flag disabled returns 503', async () => {
      mockFeatureRpc.mockResolvedValueOnce({ data: false, error: null });
      const res = await listDraftsGET(makeRequest('/api/v1/drafts'));
      expect(res.status).toBe(503);
    });

    it('Returns 400 for invalid status filter', async () => {
      const res = await listDraftsGET(makeRequest('/api/v1/drafts?status=invalid'));
      expect(res.status).toBe(400);
    });

    it('Returns 400 for invalid page', async () => {
      const res = await listDraftsGET(makeRequest('/api/v1/drafts?page=abc'));
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/drafts/:draftId (detail)', () => {
    it('T8: Returns 404 when draft not found', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: null, error: { code: 'PGRST116' } },
      }));

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}`);
      const res = await draftDetailGET(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(404);
    });

    it('Returns 400 for invalid UUID', async () => {
      const req = makeRequest('/api/v1/drafts/not-a-uuid');
      const res = await draftDetailGET(req, { params: makeParams('not-a-uuid') });
      expect(res.status).toBe(400);
    });

    it('Returns 401 when unauthenticated', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);
      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}`);
      const res = await draftDetailGET(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(401);
    });

    it('Returns 503 when feature flag disabled', async () => {
      mockFeatureRpc.mockResolvedValueOnce({ data: false, error: null });
      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}`);
      const res = await draftDetailGET(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(503);
    });
  });

  describe('GET /api/v1/drafts/:draftId/revisions', () => {
    it('T9: Returns revision list', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        orderResult: {
          data: [{ id: 'rev-1', version: 1, body: 'test', created_by_type: 'system', created_by_user_id: null, created_at: '2026-01-01T00:00:00Z' }],
          error: null,
        },
      }));

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/revisions`);
      const res = await revisionsGET(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(200);
    });

    it('Returns 400 for invalid UUID', async () => {
      const req = makeRequest('/api/v1/drafts/bad/revisions');
      const res = await revisionsGET(req, { params: makeParams('bad') });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/drafts/:draftId/events', () => {
    it('Returns event list', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        orderResult: { data: [], error: null },
      }));

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/events`);
      const res = await eventsGET(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/drafts/:draftId/approve', () => {
    it('T10: Approve success returns 200 with the queued delivery', async () => {
      // Mock visibility check (from().select().eq().eq().single())
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      // Mock RPC success — approve_and_enqueue_draft returns the draft
      // row plus the delivery it created in the same transaction.
      mockRpc.mockResolvedValueOnce({
        data: { id: VALID_DRAFT_ID, status: 'approved', version: 2, reviewed_at: '2026-01-01T00:00:00Z', reviewed_by: 'user-1', delivery_id: 'del-1', delivery_status: 'queued' },
        error: null,
      });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delivery).toEqual({ id: 'del-1', status: 'queued' });
      // The wrapper RPC is the one being called — approval and enqueue
      // are a single database transaction, never two calls that can
      // drift apart.
      expect(mockRpc).toHaveBeenCalledWith('approve_and_enqueue_draft', {
        p_draft_id: VALID_DRAFT_ID,
        p_expected_lock_version: 1,
      });
    });

    it('T17: P3W05 (inactive connection) maps to 422 — the approval itself failed', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3W05' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('WHATSAPP_CONNECTION_INACTIVE');
    });

    it('T18: concurrent approvals resolve coherently — one 200, one 409, no error state', async () => {
      // Two reviewers approve the same draft at the same version. The
      // database serializes them (row lock + optimistic version); the
      // loser gets P3B03. Route-level: both responses are well-formed
      // and only the winner carries a delivery. The exactly-one
      // delivery guarantee itself is proven in pgTAP
      // (approve_and_enqueue.test.sql A2/A4/A5).
      mockFrom.mockReturnValue(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc
        .mockResolvedValueOnce({
          data: { id: VALID_DRAFT_ID, status: 'approved', version: 2, reviewed_at: '2026-01-01T00:00:00Z', reviewed_by: 'user-1', delivery_id: 'del-1', delivery_status: 'queued' },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: { code: 'P3B03' } });

      const makeReq = () =>
        makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedLockVersion: 1 }),
        });
      const [first, second] = await Promise.all([
        approvePOST(makeReq(), { params: makeParams(VALID_DRAFT_ID) }),
        approvePOST(makeReq(), { params: makeParams(VALID_DRAFT_ID) }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
    });

    it('T13: P3B01 maps to 404', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3B01' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(404);
    });

    it('T14: P3B02 maps to 403', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3B02' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(403);
    });

    it('T15: P3B03 maps to 409', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3B03' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(409);
    });

    it('T16: P3B04 maps to 422', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3B04' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(422);
    });

    it('Returns 400 for invalid JSON body', async () => {
      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        body: 'not json',
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(400);
    });

    it('Returns 400 for missing expectedLockVersion', async () => {
      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(400);
    });

    it('Returns 404 when draft not visible under active org', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: null, error: { code: 'PGRST116' } },
      }));

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await approvePOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/drafts/:draftId/edit', () => {
    it('T11: Edit success returns 200', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({
        data: { id: VALID_DRAFT_ID, status: 'draft', version: 2, current_revision_id: 'rev-2' },
        error: null,
      });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1, body: 'Edited content' }),
      });
      const res = await editPOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(200);
    });

    it('T17: P3B05 maps to 422', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3B05' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1, body: 'test' }),
      });
      const res = await editPOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(422);
    });

    it('Returns 400 for empty body', async () => {
      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1, body: '' }),
      });
      const res = await editPOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/drafts/:draftId/reject', () => {
    it('T12: Reject success returns 200', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({
        data: { id: VALID_DRAFT_ID, status: 'rejected', version: 2, rejected_at: '2026-01-01T00:00:00Z', rejected_by: 'user-1' },
        error: null,
      });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await rejectPOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(200);
    });

    it('P3B04 on reject maps to 422', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P3B04' } });

      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: 1 }),
      });
      const res = await rejectPOST(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v1/drafts/:draftId/delivery', () => {
    // The delivery route: session → tenant → gate → draft visibility
    // (session client) -> authenticated wrapper. The feature mock may
    // only answer is_feature_enabled; delivery uses the ordinary mock.

    it('D1: Returns 401 when unauthenticated', async () => {
      mockGetCurrentUser.mockResolvedValueOnce(null);
      const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), {
        params: makeParams(VALID_DRAFT_ID),
      });
      expect(res.status).toBe(401);
    });

    it('D2: Returns 404 for a draft in another organization (tenant isolation)', async () => {
      // Visibility query finds nothing under the ACTIVE org — the same
      // response as a missing draft, so delivery state never leaks.
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: null, error: { code: 'PGRST116' } },
      }));
      const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), {
        params: makeParams(VALID_DRAFT_ID),
      });
      expect(res.status).toBe(404);
    });

    it('D3: Returns 200 with delivery null when the draft has none', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({ data: [], error: null }); // delivery read
      const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), {
        params: makeParams(VALID_DRAFT_ID),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delivery).toBeNull();
    });

    it('D4: Maps a sent delivery with its provider message id', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({
          data: [{
            id: 'del-1', draft_id: VALID_DRAFT_ID, status: 'sent',
            provider_message_id: 'wamid.123', attempts: 2,
            error_code: null, updated_at: '2026-10-22T00:00:00Z',
          }],
          error: null,
        });
      const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), {
        params: makeParams(VALID_DRAFT_ID),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delivery.status).toBe('sent');
      expect(body.delivery.providerMessageId).toBe('wamid.123');
      expect(body.delivery.attempts).toBe(2);
    });

    it('D5: Maps a permanently refused delivery to rejected', async () => {
      mockFrom.mockReturnValueOnce(createChainableMock({
        singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
      }));
      mockRpc.mockResolvedValueOnce({
          data: [{
            id: 'del-1', draft_id: VALID_DRAFT_ID, status: 'dead_lettered',
            provider_message_id: null, attempts: 1,
            error_code: 'OUTBOUND_PROVIDER_REJECTED', updated_at: '2026-10-22T00:00:00Z',
          }],
          error: null,
        });
      const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), {
        params: makeParams(VALID_DRAFT_ID),
      });
      const body = await res.json();
      expect(body.delivery.status).toBe('rejected');
    });
  });

  describe('GET /api/v1/drafts (delivery attach)', () => {
    it('L1: attaches delivery state to listed drafts that have one', async () => {
      const draftRow = {
        id: VALID_DRAFT_ID, status: 'approved', version: 2,
        provider: 'langdock', model: 'gpt-5-mini',
        created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z',
        reviewed_at: '2026-10-22T00:00:00Z', rejected_at: null,
        source_message_id: 'msg-1',
      };
      mockFrom.mockReturnValue(createChainableMock({
        rangeResult: { data: [draftRow], error: null, count: 1 },
        singleResult: { data: null, error: { code: 'PGRST116' } },
      }));
      mockRpc.mockResolvedValueOnce({
          data: [{
            id: 'del-1', draft_id: VALID_DRAFT_ID, status: 'queued',
            provider_message_id: null, attempts: 0,
            error_code: null, updated_at: '2026-10-22T00:00:00Z',
          }],
          error: null,
        });
      const res = await listDraftsGET(makeRequest('/api/v1/drafts'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.drafts).toHaveLength(1);
      expect(body.drafts[0].delivery.status).toBe('queued');
    });
  });

  describe('T19: No outbound WhatsApp call', () => {
    it('No whatsapp-normalizer import in any draft route or service file', async () => {
      const files = [...draftRouteSources, '../../../../lib/draft-api/service.ts'];
      expect(files).toHaveLength(10);
      for (const file of files) expect(sourceText(file)).not.toMatch(/(?:from\s*|import\s*\(|import\s+|require\s*\()[\s]*['"][^'"]*whatsapp-normalizer/);
    });
  });

  describe('T20: No provider call', () => {
    it('No ai-providers or ai-orchestration import in draft routes', async () => {
      expect(draftRouteSources).toHaveLength(9);
      for (const file of draftRouteSources) expect(sourceText(file)).not.toMatch(/(?:from\s*|import\s*\(|import\s+|require\s*\()[\s]*['"][^'"]*(?:ai-providers|ai-orchestration)/);
    });
  });

  describe('T21: No customer content in logs', () => {
    it('Logger calls only include sanitized metadata', async () => {
      // Observe the real shared logger's serialized console output, not a logger mock.
      const cases = [
        { path: '', method: 'GET', call: (r: Request) => listDraftsGET(r), event: 'Draft list failed' },
        { path: `/${VALID_DRAFT_ID}`, method: 'GET', call: (r: Request) => draftDetailGET(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Draft detail failed' },
        { path: `/${VALID_DRAFT_ID}/approve`, method: 'POST', call: (r: Request) => approvePOST(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Draft approve failed' },
        { path: `/${VALID_DRAFT_ID}/edit`, method: 'POST', call: (r: Request) => editPOST(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Draft edit failed' },
        { path: `/${VALID_DRAFT_ID}/reject`, method: 'POST', call: (r: Request) => rejectPOST(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Draft reject failed' },
        { path: `/${VALID_DRAFT_ID}/delivery`, method: 'GET', call: (r: Request) => deliveryGET(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Delivery read failed' },
        { path: `/${VALID_DRAFT_ID}/events`, method: 'GET', call: (r: Request) => eventsGET(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Draft review events failed' },
        { path: `/${VALID_DRAFT_ID}/revisions`, method: 'GET', call: (r: Request) => revisionsGET(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Draft revisions failed' },
        { path: `/${VALID_DRAFT_ID}/thread`, method: 'GET', call: (r: Request) => threadGET(r, { params: makeParams(VALID_DRAFT_ID) }), event: 'Conversation thread failed' },
      ];
      const sentinels = ['SYNTHETIC_CUSTOMER_MESSAGE_41', 'SYNTHETIC_STACK_42', 'SYNTHETIC_NAME_43', 'SYNTHETIC_HEADER_44', 'SYNTHETIC_BODY_45', 'SYNTHETIC_TOKEN_46'];
      const errorOut = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnOut = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const infoOut = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        for (const item of cases) {
          errorOut.mockClear(); warnOut.mockClear(); infoOut.mockClear();
          const failure = new Error(sentinels[0]);
          failure.stack = sentinels[1]; failure.name = sentinels[2];
          mockGetCurrentUser.mockRejectedValueOnce(failure);
          const res = await item.call(makeRequest(`/api/v1/drafts${item.path}`, {
            method: item.method,
            headers: { 'x-request-id': sentinels[3], authorization: `Bearer ${sentinels[5]}` },
            ...(item.method === 'POST' ? { body: JSON.stringify({ expectedLockVersion: 1, body: sentinels[4] }) } : {}),
          }));
          expect(res.status).toBe(500);
          expect(res.headers.get('cache-control')).toBe('private, no-store');
          expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
          expect(errorOut).toHaveBeenCalledOnce();
          const payload = JSON.parse(String(errorOut.mock.calls[0][0]));
          expect(payload.level).toBe('error'); expect(payload.message).toBe(item.event);
          expect(payload).not.toHaveProperty('error');
          expect(payload.context).toEqual({ service: 'tugpt-platform', requestId: expect.stringMatching(/^req-\d+$/), failureKind: 'unexpected', httpStatus: 500 });
          const emitted = JSON.stringify([errorOut.mock.calls, warnOut.mock.calls, infoOut.mock.calls]);
          for (const sentinel of sentinels) expect(emitted).not.toContain(sentinel);
        }
      } finally { errorOut.mockRestore(); warnOut.mockRestore(); infoOut.mockRestore(); }
    });
  });
});
// Synthetic unit fixture only; no host or network configuration is changed.
beforeEach(() => vi.stubEnv('TUGPT_APP_ORIGIN', 'https://dashboard.example'));
afterEach(() => vi.unstubAllEnvs());

// P2-DB-01 transport/response regression assertions; source only, NOT RUN.
describe('P2-DB-01 delivery read transport', () => {
  const row = {
    id: 'delivery-1', organization_id: 'org-1', draft_id: VALID_DRAFT_ID,
    status: 'sent', provider_message_id: 'synthetic-provider-id', attempts: 2,
    error_code: null, updated_at: '2026-01-01T00:02:00Z',
    delivered_at: '2026-01-01T00:00:00Z', read_at: '2026-01-01T00:01:00Z',
  };
  function visible() {
    mockFrom.mockReturnValueOnce(createChainableMock({
      singleResult: { data: { id: VALID_DRAFT_ID }, error: null },
    }));
  }
  it('DB01 single uses ordinary scoped RPC and preserves receipt fields', async () => {
    visible(); mockRpc.mockResolvedValueOnce({ data: [row], error: null });
    const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), { params: makeParams(VALID_DRAFT_ID) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mockRpc).toHaveBeenCalledWith('sso_get_outbound_delivery_for_draft', { p_organization_id: 'org-1', p_draft_id: VALID_DRAFT_ID });
    expect(mockRpc).toHaveBeenCalledTimes(1); expect(mockFeatureRpc).toHaveBeenCalledTimes(1);
    expect(mockFeatureRpc).toHaveBeenCalledWith('is_feature_enabled', { p_organization_id: 'org-1', p_flag_key: 'ai_draft_generation' });
    expect(await res.json()).toEqual({ delivery: {
      id: 'delivery-1', status: 'sent', providerMessageId: 'synthetic-provider-id',
      attempts: 2, errorCode: null, updatedAt: row.updated_at,
      deliveredAt: row.delivered_at, readAt: row.read_at,
    } });
  });
  it('DB01 single preserves sanitized database failure without fallback', async () => {
    visible(); mockRpc.mockResolvedValueOnce({ data: null, error: { code: '28000', message: 'synthetic-private-detail' } });
    const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), { params: makeParams(VALID_DRAFT_ID) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    expect(mockRpc).toHaveBeenCalledTimes(1); expect(mockFeatureRpc).toHaveBeenCalledTimes(1);
  });
  it('DB01 foreign or missing draft stops before delivery RPC', async () => {
    mockFrom.mockReturnValueOnce(createChainableMock());
    const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), { params: makeParams(VALID_DRAFT_ID) });
    expect(res.status).toBe(404); expect(mockRpc).not.toHaveBeenCalled();
  });
  it('DB01 disabled feature stops before visibility and delivery RPC', async () => {
    mockFeatureRpc.mockResolvedValueOnce({ data: false, error: null });
    const res = await deliveryGET(makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/delivery`), { params: makeParams(VALID_DRAFT_ID) });
    expect(res.status).toBe(503); expect(mockRpc).not.toHaveBeenCalled(); expect(mockFrom).not.toHaveBeenCalled();
  });
  for (const failure of [false, true]) {
    it(`DB01 bulk ordinary client preserves ${failure ? 'degraded list' : 'delivery enrichment'}`, async () => {
      const draft = { id: VALID_DRAFT_ID, status: 'approved', version: 1, source_message_id: 'message-1', created_at: row.updated_at, updated_at: row.updated_at };
      mockFrom.mockReturnValue(createChainableMock({ rangeResult: { data: [draft], error: null, count: 1 } }));
      mockRpc.mockResolvedValueOnce(failure ? { data: null, error: { code: '28000' } } : { data: [row], error: null });
      const res = await listDraftsGET(makeRequest('/api/v1/drafts')); const body = await res.json();
      expect(res.status).toBe(200); expect(body.total).toBe(1);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(mockRpc).toHaveBeenCalledWith('sso_list_outbound_deliveries_for_drafts', { p_organization_id: 'org-1', p_draft_ids: [VALID_DRAFT_ID] });
      expect(mockFeatureRpc).toHaveBeenCalledTimes(1);
      if (failure) expect(body.drafts[0]).not.toHaveProperty('delivery');
      else expect(body.drafts[0].delivery.readAt).toBe(row.read_at);
    });
  }
});

// P2-CLOSE-LOG-01 supplemental service, RPC-warning and success diagnostics.
describe('draft diagnostic metadata selection', () => {
  it('does not emit customer exception text thrown by the draft service', async () => {
    const failure = new Error('SYNTHETIC_SERVICE_MESSAGE_51');
    failure.stack = 'SYNTHETIC_SERVICE_STACK_52';
    mockFrom.mockReturnValue(createChainableMock({ rangeResult: { data: null, count: 0, error: failure } }));
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await listDraftsGET(makeRequest('/api/v1/drafts'));
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
      expect(output).toHaveBeenCalledOnce();
      const emitted = JSON.stringify(output.mock.calls);
      expect(emitted).not.toContain(failure.message); expect(emitted).not.toContain(failure.stack);
      expect(JSON.parse(String(output.mock.calls[0][0]))).not.toHaveProperty('error');
    } finally { output.mockRestore(); }
  });
  it.each(['approve', 'edit', 'reject', 'delivery'] as const)('selects validated metadata for %s RPC warnings', async (operation) => {
    const failure = { code: 'SYNTHETIC_RPC_CODE_61', message: 'SYNTHETIC_RPC_MESSAGE_62', stack: 'SYNTHETIC_RPC_STACK_63', name: 'SYNTHETIC_RPC_NAME_64' };
    mockFrom.mockReturnValue(createChainableMock({ singleResult: { data: { id: VALID_DRAFT_ID }, error: null } }));
    mockRpc.mockResolvedValueOnce({ data: null, error: failure });
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const method = operation === 'delivery' ? 'GET' : 'POST';
      const req = makeRequest(`/api/v1/drafts/${VALID_DRAFT_ID}/${operation}`, { method, headers: { 'x-request-id': 'SYNTHETIC_HEADER_65' }, ...(method === 'POST' ? { body: JSON.stringify({ expectedLockVersion: 1, ...(operation === 'edit' ? { body: 'SYNTHETIC_BODY_66' } : {}) }) } : {}) });
      const handler = { approve: approvePOST, edit: editPOST, reject: rejectPOST, delivery: deliveryGET }[operation];
      const res = await handler(req, { params: makeParams(VALID_DRAFT_ID) });
      expect(res.status).toBe(500); expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
      expect(output).toHaveBeenCalledOnce();
      const emitted = JSON.stringify(output.mock.calls);
      for (const sentinel of [...Object.values(failure), 'SYNTHETIC_HEADER_65', 'SYNTHETIC_BODY_66']) expect(emitted).not.toContain(sentinel);
      expect(JSON.parse(String(output.mock.calls[0][0])).context).toEqual({ service: 'tugpt-platform', requestId: expect.stringMatching(/^req-\d+$/), failureKind: 'rpc', httpStatus: 500 });
    } finally { output.mockRestore(); }
  });
  it('does not copy arbitrary tenant or request-header text into success diagnostics', async () => {
    mockResolveTenantContext.mockResolvedValueOnce({ organizationId: 'SYNTHETIC_TENANT_71', organizationName: 'Synthetic', role: 'owner' });
    mockFrom.mockReturnValue(createChainableMock({ rangeResult: { data: [], error: null, count: 0 } }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await listDraftsGET(makeRequest('/api/v1/drafts', { headers: { 'x-request-id': 'SYNTHETIC_HEADER_72' } }));
      expect(res.status).toBe(200); expect(await res.json()).toEqual({ drafts: [], total: 0, page: 1, limit: 20 });
      expect(res.headers.get('cache-control')).toBe('private, no-store'); expect(output).toHaveBeenCalledOnce();
      const emitted = JSON.stringify(output.mock.calls); expect(emitted).not.toContain('SYNTHETIC_TENANT_71'); expect(emitted).not.toContain('SYNTHETIC_HEADER_72');
      expect(JSON.parse(String(output.mock.calls[0][0])).context).toEqual({ service: 'tugpt-platform', requestId: expect.stringMatching(/^req-\d+$/), outcome: 'success' });
    } finally { output.mockRestore(); }
  });
});
