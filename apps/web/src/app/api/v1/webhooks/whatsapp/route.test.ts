import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock feature flags
const mockIsEnabled = vi.fn().mockReturnValue(true);
vi.mock('@tugpt/feature-flags', () => ({
  featureFlagService: {
    isEnabled: mockIsEnabled,
  },
}));

// Mock database
const mockRpc = vi.fn().mockResolvedValue({ data: { is_new: true, webhook_event_id: 'test-uuid' }, error: null });
vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn().mockReturnValue({
    rpc: mockRpc,
  }),
}));

const APP_SECRET = 'test-secret';

// Helper to create a signed request
function createSignedRequest(body: object, secret: string = APP_SECRET): Request {
  const bodyStr = JSON.stringify(body);
  const rawBody = Buffer.from(bodyStr, 'utf-8');
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex');
  const signature = `sha256=${mac}`;

  return new Request('http://localhost/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: bodyStr,
  });
}

function createSignedRawRequest(bodyStr: string, secret: string = APP_SECRET): Request {
  const rawBody = Buffer.from(bodyStr, 'utf-8');
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex');
  const signature = `sha256=${mac}`;

  return new Request('http://localhost/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body: bodyStr,
  });
}

describe('whatsapp webhook route', () => {
  beforeEach(() => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'test-verify-token');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockRpc.mockResolvedValue({ data: { is_new: true, webhook_event_id: 'test-uuid' }, error: null });
  });

  // A1: GET webhook verification returns hub.challenge when token matches and flag enabled
  it('GET returns challenge when token matches', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abc123');
  });

  // A2: GET returns 403 when mode is not subscribe
  it('GET returns 403 when mode is not subscribe', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
  });

  // A3: GET webhook verification returns 403 when token mismatch
  it('GET returns 403 when token mismatch', async () => {
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(403);
  });

  // A4: POST webhook with valid signature calls ingest RPC and returns 200
  it('POST with valid signature and empty events returns 200', async () => {
    const body = { entry: [] };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
  });

  // A5: POST webhook with invalid signature returns 401
  it('POST with invalid signature returns 401', async () => {
    const body = { entry: [] };
    const bodyStr = JSON.stringify(body);
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: bodyStr,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(401);
  });

  // A6: POST webhook with missing signature returns 401
  it('POST with missing signature returns 401', async () => {
    const body = { entry: [] };
    const bodyStr = JSON.stringify(body);
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyStr,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(401);
  });

  // A7: POST webhook with correctly signed malformed JSON returns 400
  it('POST with signed malformed JSON returns 400', async () => {
    const malformedBody = '{invalid json';
    const request = createSignedRawRequest(malformedBody);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(400);
  });

  // A8: Feature disabled behavior — POST returns 404 when flag is off
  it('POST returns 404 when feature flag is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const body = { entry: [] };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(404);
  });

  // A9: Feature disabled behavior — GET returns 404 when flag is off
  it('GET returns 404 when feature flag is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const url = 'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123';
    const request = new Request(url, { method: 'GET' });
    const { GET } = await import('./route');
    const response = await GET(request as unknown as Parameters<typeof GET>[0]);
    expect(response.status).toBe(404);
  });

  // A10: Unsupported content type returns 415
  it('POST with unsupported content type returns 415', async () => {
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'test',
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(415);
  });

  // A11: Content-type with charset parameter is accepted
  it('POST with content-type charset parameter is accepted', async () => {
    const body = { entry: [] };
    const bodyStr = JSON.stringify(body);
    const rawBody = Buffer.from(bodyStr, 'utf-8');
    const mac = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    const request = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-hub-signature-256': `sha256=${mac}`,
      },
      body: bodyStr,
    });
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
  });

  // A12: POST with valid signature and real message events calls ingest RPC
  it('POST with valid message events calls ingest RPC', async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.test1', from: '15551234567', type: 'text', text: { body: 'Hello' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('ingest_whatsapp_message_event', expect.objectContaining({
      p_provider_connection_identifier: '12345',
      p_provider_event_key: 'wamid.test1',
    }));
  });

  // A13: POST with ingest RPC error returns 500
  it('POST with ingest RPC error returns 500', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'CONNECTION_NOT_FOUND' } });
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.test2', from: '15551234567', type: 'text', text: { body: 'Hello' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(500);
  });

  // A14: POST with multiple messages in one envelope ingests each independently
  it('POST with multiple messages ingests each independently', async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  { id: 'wamid.multi1', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' },
                  { id: 'wamid.multi2', from: '222', type: 'text', text: { body: 'B' }, timestamp: '1700000001' },
                ],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  // A15: POST with duplicate events (same message ID) calls ingest for each (dedup is DB-side)
  it('POST with duplicate message IDs calls ingest for each (dedup handled by DB)', async () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.dup', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [{ id: 'wamid.dup', from: '111', type: 'text', text: { body: 'A' }, timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  // A16: Bounded raw-body reading — oversized body returns 413
  it('POST with oversized body returns 413', async () => {
    // Default limit is 1MB (1048576 bytes). Create a body larger than that.
    const largeString = 'x'.repeat(1100000);
    const largeBody = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: 'x' },
            messages: [{
              id: 'wamid.large',
              from: '1',
              type: 'text',
              text: { body: largeString },
              timestamp: '1',
            }],
          },
        }],
      }],
    });
    const request = createSignedRawRequest(largeBody);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    expect(response.status).toBe(413);
  });
});

/**
 * The 2026-08-31 guard: a missing secret must fail closed.
 *
 * Every test in this block was a PASS for the attacker before that change —
 * that is, the endpoint answered 200 and did the work. The route read both
 * secrets as `process.env.X || ''`, so an unconfigured server compared an
 * anonymous caller's input against the empty string and agreed with it.
 *
 * None of this was reachable on 2026-08-31: `whatsapp_integration` is false and
 * both handlers 404 first. The flag is a product switch, not a security
 * control, and the whole point is that the day it is flipped must not also be
 * the day anyone checks whether `/etc/tugpt/web.env` has these two lines in it.
 *
 * These tests can stub the environment per test only because the route now
 * reads `process.env` per request. While the values were module-level
 * constants, the whole file shared whatever was set before the first
 * `await import('./route')`, and a later `vi.stubEnv` changed nothing —
 * silently, which is the worst way for a security test to be wrong.
 */
describe('whatsapp webhook route: missing secrets fail closed', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'test-verify-token');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockRpc.mockResolvedValue({ data: { is_new: true, webhook_event_id: 'test-uuid' }, error: null });
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function getRequest(query: string): Request {
    return new Request(`http://localhost/api/v1/webhooks/whatsapp?${query}`, { method: 'GET' });
  }

  describe('GET, with no verify token configured', () => {
    it('refuses an empty hub.verify_token instead of handing over the challenge', async () => {
      // THE ATTACK. `?hub.verify_token=` (empty) against `VERIFY_TOKEN = ''`
      // matched, and this returned 200 with the challenge echoed back —
      // completing Meta's webhook handshake for anyone who asked for it.
      vi.stubEnv('WHATSAPP_VERIFY_TOKEN', undefined);
      const { GET } = await import('./route');
      const response = await GET(
        getRequest('hub.mode=subscribe&hub.verify_token=&hub.challenge=abc123') as unknown as Parameters<typeof GET>[0]
      );

      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('abc123');
    });

    it('refuses a whitespace-only token, matched by a whitespace-only guess', async () => {
      vi.stubEnv('WHATSAPP_VERIFY_TOKEN', '   ');
      const { GET } = await import('./route');
      const response = await GET(
        getRequest('hub.mode=subscribe&hub.verify_token=%20%20%20&hub.challenge=abc123') as unknown as Parameters<typeof GET>[0]
      );
      expect(response.status).toBe(403);
    });

    it('answers exactly as it does for a wrong token, telling a prober nothing', async () => {
      // Same status, same empty body. Whether this server is configured is not
      // something an anonymous caller gets to learn by asking.
      vi.stubEnv('WHATSAPP_VERIFY_TOKEN', undefined);
      const { GET } = await import('./route');
      const unconfigured = await GET(
        getRequest('hub.mode=subscribe&hub.verify_token=guess&hub.challenge=abc') as unknown as Parameters<typeof GET>[0]
      );

      vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'test-verify-token');
      const wrongToken = await GET(
        getRequest('hub.mode=subscribe&hub.verify_token=guess&hub.challenge=abc') as unknown as Parameters<typeof GET>[0]
      );

      expect(unconfigured.status).toBe(wrongToken.status);
      expect(await unconfigured.text()).toBe(await wrongToken.text());
    });

    it('tells the operator, in the log, what the caller is not told', async () => {
      vi.stubEnv('WHATSAPP_VERIFY_TOKEN', undefined);
      const { GET } = await import('./route');
      await GET(getRequest('hub.mode=subscribe&hub.verify_token=') as unknown as Parameters<typeof GET>[0]);

      expect(consoleError).toHaveBeenCalled();
      expect(String(consoleError.mock.calls[0][0])).toContain('WHATSAPP_VERIFY_TOKEN');
    });

    it('still verifies normally when the token is configured', async () => {
      // The guard has to refuse blanks without refusing anything else.
      const { GET } = await import('./route');
      const response = await GET(
        getRequest('hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123') as unknown as Parameters<typeof GET>[0]
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('abc123');
    });
  });

  describe('POST, with no app secret configured', () => {
    it('refuses a payload signed with the empty secret, and ingests nothing', async () => {
      // THE OTHER ATTACK, and the worse one. HMAC-SHA256 keyed on '' is a
      // signature anyone can compute — Meta documents the algorithm — so every
      // forged payload entered the pipeline as a genuine customer message.
      vi.stubEnv('WHATSAPP_APP_SECRET', undefined);
      const forged = createSignedRequest(
        {
          entry: [{
            changes: [{
              value: {
                metadata: { phone_number_id: 'x' },
                messages: [{ id: 'wamid.forged', from: '1', type: 'text', text: { body: 'hola' }, timestamp: '1' }],
              },
            }],
          }],
        },
        '' // the key the server would have used
      );

      const { POST } = await import('./route');
      const response = await POST(forged as unknown as Parameters<typeof POST>[0]);

      expect(response.status).toBe(401);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('refuses a whitespace-only secret the same way', async () => {
      vi.stubEnv('WHATSAPP_APP_SECRET', '   ');
      const forged = createSignedRequest({ entry: [] }, '   ');
      const { POST } = await import('./route');
      const response = await POST(forged as unknown as Parameters<typeof POST>[0]);
      expect(response.status).toBe(401);
    });

    it('answers exactly as it does for a forged signature', async () => {
      vi.stubEnv('WHATSAPP_APP_SECRET', undefined);
      const { POST } = await import('./route');
      const unconfigured = await POST(
        createSignedRequest({ entry: [] }, 'anything') as unknown as Parameters<typeof POST>[0]
      );

      vi.stubEnv('WHATSAPP_APP_SECRET', APP_SECRET);
      const forged = await POST(
        createSignedRequest({ entry: [] }, 'wrong-secret') as unknown as Parameters<typeof POST>[0]
      );

      expect(unconfigured.status).toBe(forged.status);
      expect(await unconfigured.text()).toBe(await forged.text());
    });

    it('tells the operator which variable is missing', async () => {
      vi.stubEnv('WHATSAPP_APP_SECRET', undefined);
      const { POST } = await import('./route');
      await POST(createSignedRequest({ entry: [] }, '') as unknown as Parameters<typeof POST>[0]);

      expect(consoleError).toHaveBeenCalled();
      expect(String(consoleError.mock.calls[0][0])).toContain('WHATSAPP_APP_SECRET');
    });

    it('never puts the secret itself in the log', async () => {
      // The one rule a function whose job is to talk about a secret is most
      // likely to break. docs/production_environment.md: no secrets in logs.
      vi.stubEnv('WHATSAPP_APP_SECRET', '   ');
      const { POST } = await import('./route');
      await POST(createSignedRequest({ entry: [] }, '   ') as unknown as Parameters<typeof POST>[0]);

      const logged = consoleError.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
      expect(logged).not.toContain('test-secret');
    });

    it('refuses before reading the body at all', async () => {
      // A request that cannot be authenticated should not be parsed, sized or
      // hashed. An unauthenticated caller must not be able to make this server
      // do a megabyte of work by sending a megabyte.
      vi.stubEnv('WHATSAPP_APP_SECRET', undefined);
      const request = createSignedRequest({ entry: [] }, '');
      const textSpy = vi.spyOn(request, 'text');

      const { POST } = await import('./route');
      const response = await POST(request as unknown as Parameters<typeof POST>[0]);

      expect(response.status).toBe(401);
      expect(textSpy).not.toHaveBeenCalled();
    });

    it('still accepts a correctly signed payload when the secret is configured', async () => {
      const { POST } = await import('./route');
      const response = await POST(
        createSignedRequest({ entry: [] }) as unknown as Parameters<typeof POST>[0]
      );
      expect(response.status).toBe(200);
    });
  });

  it('reads the environment per request, not once per process', async () => {
    // The property the tests above depend on. If someone reinstates
    // module-level `const APP_SECRET = process.env...`, the two calls below
    // return the same status and this fails — which is the only warning the
    // rest of this block would otherwise get, since it would keep passing on
    // whichever value happened to be set first.
    const { GET } = await import('./route');
    const query = 'hub.mode=subscribe&hub.verify_token=second-token&hub.challenge=abc';

    const before = await GET(getRequest(query) as unknown as Parameters<typeof GET>[0]);
    expect(before.status).toBe(403);

    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'second-token');
    const after = await GET(getRequest(query) as unknown as Parameters<typeof GET>[0]);
    expect(after.status).toBe(200);
  });

  // --- Delivery receipts (20261022000005) -----------------------------------
  //
  // Status callbacks ride the same envelope as messages, in a
  // sibling `statuses` array. The route applies them through
  // record_outbound_delivery_receipt and NEVER fails the webhook
  // for a receipt problem: receipts refine state, messages are the
  // payload that matters, and a 500 would make Meta retry both.

  const statusPayload = (statuses: unknown[]) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '12345' },
              statuses,
            },
          },
        ],
      },
    ],
  });

  it('POST with a status-only payload applies the receipt and returns 200', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const request = createSignedRequest(
      statusPayload([{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1729000000' }])
    );
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('record_outbound_delivery_receipt', {
      p_provider_message_id: 'wamid.OUT1',
      p_status: 'delivered',
      p_event_at: new Date(1729000000 * 1000).toISOString(),
    });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'ingest_whatsapp_message_event',
      expect.anything()
    );
  });

  it('POST with a receipt RPC failure still returns 200 and does not retry-storm Meta', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'boom' },
    });
    const request = createSignedRequest(
      statusPayload([{ id: 'wamid.OUT1', status: 'read', timestamp: '1729000100' }])
    );
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
  });

  it('POST with a mixed payload ingests the message AND applies the receipt', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '12345' },
                messages: [
                  {
                    id: 'wamid.IN1',
                    from: '34611223344',
                    timestamp: '1729000000',
                    type: 'text',
                    text: { body: 'Hola' },
                  },
                ],
                statuses: [{ id: 'wamid.OUT1', status: 'read', timestamp: '1729000200' }],
              },
            },
          ],
        },
      ],
    };
    const request = createSignedRequest(body);
    const { POST } = await import('./route');
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'ingest_whatsapp_message_event',
      expect.objectContaining({ p_provider_message_id: 'wamid.IN1' })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'record_outbound_delivery_receipt',
      expect.objectContaining({ p_provider_message_id: 'wamid.OUT1', p_status: 'read' })
    );
  });
});
