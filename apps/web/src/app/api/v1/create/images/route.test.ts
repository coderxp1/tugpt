import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const ORG = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ORG = '11111111-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID = '0b8f6f4e-2a43-4c1b-9d55-3f1f2a6b7c8d';

const ctx = vi.fn();
vi.mock('@/lib/chat/request', async (orig) => ({ ...(await orig<typeof import('@/lib/chat/request')>()), chatContext: (...a: unknown[]) => ctx(...a) }));

const service = { health: vi.fn(), submit: vi.fn(), status: vi.fn(), cancel: vi.fn(), result: vi.fn() };
let configured = true;
vi.mock('@/lib/create/image-service', async (orig) => ({ ...(await orig<typeof import('@/lib/create/image-service')>()), configuredImageService: () => (configured ? service : null) }));

const store = { listGenerations: vi.fn(), getGeneration: vi.fn(), insertGeneration: vi.fn(), recordStatus: vi.fn() };
vi.mock('@/lib/create/store', async (orig) => ({ ...(await orig<typeof import('@/lib/create/store')>()), ...{
  listGenerations: (...a: unknown[]) => store.listGenerations(...a), getGeneration: (...a: unknown[]) => store.getGeneration(...a),
  insertGeneration: (...a: unknown[]) => store.insertGeneration(...a), recordStatus: (...a: unknown[]) => store.recordStatus(...a),
} }));

import { GET as list, POST as submit } from './route';
import { GET as status } from './[imageId]/route';
import { POST as cancel } from './[imageId]/cancel/route';
import { GET as file } from './[imageId]/file/route';

const ORIGIN = 'https://localhost:3443';
const row = (over: Record<string, unknown> = {}) => ({ id: ID, prompt: 'a cat', width: 1024, height: 1024, seed: 7, modelKey: 'Tongyi-MAI/Z-Image-Turbo', status: 'processing', progress: 30, errorCode: null, seconds: null, createdAt: '2026-11-15T10:00:00Z', finishedAt: null, ...over });
const params = (imageId = ID) => ({ params: Promise.resolve({ imageId }) });
function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TUGPT_APP_ORIGIN = ORIGIN;
  configured = true;
  ctx.mockResolvedValue({ db: {}, userId: USER, tenant: { organizationId: ORG } });
  service.health.mockResolvedValue({ ready: true, model: 'Tongyi-MAI/Z-Image-Turbo' });
});

describe('POST /api/v1/create/images', () => {
  it('rejects cross-site and header-less requests before touching the session or GPU', async () => {
    const variants: Record<string, string>[] = [{ origin: 'https://evil.example' }, { 'x-tugpt-csrf': '' }, { 'content-type': 'text/plain' }];
    for (const h of variants) {
      const res = await submit(post('https://localhost:3443/api/v1/create/images', { prompt: 'x', size: 'square' }, h));
      expect(res.status).toBe(403);
    }
    expect(ctx).not.toHaveBeenCalled();
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('validates the body strictly (no organization override, prompt and size rules)', async () => {
    const bad = [
      { prompt: 'x', size: 'square', organizationId: OTHER_ORG },
      { prompt: '   ', size: 'square' },
      { prompt: 'x'.repeat(1001), size: 'square' },
      { prompt: 'bad\u0000byte', size: 'square' },
      { prompt: 'x', size: '4k' },
      { prompt: 'x', size: 'square', seed: -1 },
      { prompt: 'x', size: 'square', seed: 1.5 },
    ];
    for (const body of bad) expect((await submit(post('https://localhost:3443/api/v1/create/images', body))).status).toBe(400);
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('uses the session organization, records the job and returns no tenant ids', async () => {
    service.submit.mockResolvedValue({ id: ID, status: 'queued', progress: 0, seconds: null, error: null });
    store.insertGeneration.mockResolvedValue(row({ status: 'queued', progress: 0 }));
    const res = await submit(post('https://localhost:3443/api/v1/create/images', { prompt: '  a cat  ', size: 'landscape', seed: 7 }));
    expect(res.status).toBe(202);
    const sent = service.submit.mock.calls[0][0];
    expect(sent).toMatchObject({ organizationId: ORG, prompt: 'a cat', width: 1280, height: 720, seed: 7 });
    expect(store.insertGeneration.mock.calls[0][1]).toMatchObject({ id: sent.id, organizationId: ORG, userId: USER });
    const text = await res.text();
    expect(text).not.toContain(ORG);
    expect(text).not.toContain(USER);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('cancels the GPU job if the history row cannot be written', async () => {
    service.submit.mockResolvedValue({ id: ID, status: 'queued', progress: 0, seconds: null, error: null });
    store.insertGeneration.mockRejectedValue(new Error('db down'));
    service.cancel.mockResolvedValue({});
    const res = await submit(post('https://localhost:3443/api/v1/create/images', { prompt: 'a cat', size: 'square' }));
    expect(res.status).toBe(503);
    expect(service.cancel).toHaveBeenCalledWith(service.submit.mock.calls[0][0].id, ORG);
  });

  it('explains a busy organization and an unconfigured service', async () => {
    const { ImageServiceError } = await import('@/lib/create/image-service');
    service.submit.mockRejectedValue(new ImageServiceError('ORGANIZATION_BUSY', 429));
    const busy = await submit(post('https://localhost:3443/api/v1/create/images', { prompt: 'a cat', size: 'square' }));
    expect(busy.status).toBe(429);
    expect((await busy.json()).message).toMatch(/still being generated/);
    configured = false;
    const off = await submit(post('https://localhost:3443/api/v1/create/images', { prompt: 'a cat', size: 'square' }));
    expect(off.status).toBe(503);
    expect((await off.json()).error).toBe('NOT_CONFIGURED');
  });

  it('passes through the session refusal', async () => {
    ctx.mockResolvedValue(NextResponse.json({ error: 'Unauthenticated' }, { status: 401 }));
    expect((await submit(post('https://localhost:3443/api/v1/create/images', { prompt: 'a cat', size: 'square' }))).status).toBe(401);
  });
});

describe('GET /api/v1/create/images', () => {
  it('lists the caller history and reports availability honestly', async () => {
    store.listGenerations.mockResolvedValue([row({ status: 'completed', progress: 100 })]);
    const body = await (await list(new Request('https://localhost:3443/api/v1/create/images'))).json();
    expect(store.listGenerations.mock.calls[0].slice(1)).toEqual([ORG, USER]);
    // CONF-1/N2: no upstream model id in the customer response.
    expect(body.service).toEqual({ configured: true, available: true });
    expect(JSON.stringify(body)).not.toContain('Z-Image');
    expect(body.images[0].fileUrl).toBe(`/api/v1/create/images/${ID}/file`);
    service.health.mockRejectedValue(new Error('down'));
    expect((await (await list(new Request('https://localhost:3443/api/v1/create/images'))).json()).service.available).toBe(false);
  });
});

describe('per-image routes', () => {
  it('never asks the GPU about an image the caller does not own', async () => {
    store.getGeneration.mockResolvedValue(null);
    expect((await status(new Request('https://localhost:3443/x'), params())).status).toBe(404);
    expect((await file(new Request('https://localhost:3443/x'), params())).status).toBe(404);
    expect((await cancel(post('https://localhost:3443/x', {}), params())).status).toBe(404);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.result).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
    expect(store.getGeneration.mock.calls[0].slice(1)).toEqual([ORG, USER, ID]);
    expect((await status(new Request('https://localhost:3443/x'), params('../../etc'))).status).toBe(404);
  });

  it('refreshes a running job and records the change', async () => {
    store.getGeneration.mockResolvedValue(row());
    service.status.mockResolvedValue({ id: ID, status: 'completed', progress: 100, seconds: 1.8, error: null });
    store.recordStatus.mockResolvedValue(row({ status: 'completed', progress: 100, seconds: 1.8 }));
    const body = await (await status(new Request('https://localhost:3443/x'), params())).json();
    expect(service.status).toHaveBeenCalledWith(ID, ORG);
    expect(store.recordStatus.mock.calls[0][4]).toMatchObject({ status: 'completed', progress: 100 });
    expect(body.image.status).toBe('completed');
  });

  it('serves the PNG only when completed, with hardened headers', async () => {
    store.getGeneration.mockResolvedValue(row());
    expect((await file(new Request('https://localhost:3443/x'), params())).status).toBe(409);
    store.getGeneration.mockResolvedValue(row({ status: 'completed', progress: 100 }));
    service.result.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const res = await file(new Request('https://localhost:3443/x?download=1'), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="tugpt-image-0b8f6f4e\.png"$/);
    expect(service.result).toHaveBeenCalledWith(ID, ORG);
  });

  it('marks an image expired when the GPU no longer has it', async () => {
    const { ImageServiceError } = await import('@/lib/create/image-service');
    store.getGeneration.mockResolvedValue(row({ status: 'completed', progress: 100 }));
    service.result.mockRejectedValue(new ImageServiceError('RESULT_EXPIRED', 410));
    store.recordStatus.mockResolvedValue(row({ status: 'expired' }));
    expect((await file(new Request('https://localhost:3443/x'), params())).status).toBe(410);
    expect(store.recordStatus.mock.calls[0][4]).toMatchObject({ status: 'expired' });
  });

  it('cancel requires the CSRF header', async () => {
    expect((await cancel(post('https://localhost:3443/x', {}, { 'x-tugpt-csrf': '' }), params())).status).toBe(403);
    expect(ctx).not.toHaveBeenCalled();
  });
});

describe('IMAGES-NEUTRAL: customer error codes carry no infrastructure wording', () => {
  it('a failed GPU job is stored raw (backend-only) but returned as GENERATION_FAILED', async () => {
    store.getGeneration.mockResolvedValue(row());
    service.status.mockResolvedValue({ id: ID, status: 'failed', progress: 30, seconds: null, error: 'GPU_INFERENCE_FAILED' });
    store.recordStatus.mockResolvedValue(row({ status: 'failed', errorCode: 'GPU_INFERENCE_FAILED' }));
    const res = await status(new Request('https://localhost:3443/x'), params());
    const text = await res.text();
    expect(store.recordStatus.mock.calls[0][4]).toMatchObject({ status: 'failed', errorCode: 'GPU_INFERENCE_FAILED' });
    expect(JSON.parse(text).image.errorCode).toBe('GENERATION_FAILED');
    expect(text).not.toMatch(/GPU|CUDA|VRAM|inference/i);
  });

  it('history lists map every stored code, including unknown upstream strings', async () => {
    store.listGenerations.mockResolvedValue([
      row({ status: 'failed', errorCode: 'GPU_SHUTDOWN' }),
      row({ status: 'failed', errorCode: 'CUDA out of memory at 10.0.0.5' }),
      row({ status: 'expired', errorCode: 'RESULT_EXPIRED' }),
      row({ status: 'expired', errorCode: 'JOB_NOT_FOUND' }),
      row({ status: 'completed', errorCode: null }),
    ]);
    const res = await list(new Request('https://localhost:3443/api/v1/create/images'));
    const text = await res.text();
    expect(JSON.parse(text).images.map((i: { errorCode: unknown }) => i.errorCode))
      .toEqual(['GENERATION_INTERRUPTED', 'GENERATION_FAILED', 'RESULT_EXPIRED', 'JOB_NOT_FOUND', null]);
    expect(text).not.toMatch(/GPU|CUDA|10\.0\.0\.5/);
  });

  it('cancel responses are mapped too', async () => {
    store.getGeneration.mockResolvedValue(row({ status: 'failed', errorCode: 'GPU_INFERENCE_FAILED' }));
    const body = await (await cancel(post('https://localhost:3443/x', {}), params())).json();
    expect(body.image.errorCode).toBe('GENERATION_FAILED');
  });
});

