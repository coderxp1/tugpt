import { describe, expect, it, vi } from 'vitest';
import { ImageServiceClient, ImageServiceError, imageServiceConfig, parseGpuJob, sizeOf } from './image-service';

const TOKEN = 'T'.repeat(64);
const ID = '0b8f6f4e-2a43-4c1b-9d55-3f1f2a6b7c8d';
const ORG = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const config = { baseUrl: 'http://127.0.0.1:18766', tokenFile: '/etc/tugpt-gpu-image/api-token' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, token = TOKEN) {
  return new ImageServiceClient(config, { fetchImpl, readToken: async () => token });
}

describe('imageServiceConfig', () => {
  it('accepts only a loopback HTTP origin and an absolute token file', () => {
    expect(imageServiceConfig({ TUGPT_IMAGE_SERVICE_URL: 'http://127.0.0.1:18766', TUGPT_IMAGE_SERVICE_TOKEN_FILE: '/etc/x' }))
      .toEqual({ baseUrl: 'http://127.0.0.1:18766', tokenFile: '/etc/x' });
    for (const url of ['http://82.165.178.153:18765', 'https://gpu.example.com', 'http://user:pw@127.0.0.1:1', 'http://127.0.0.1:1/v1', 'http://127.0.0.1.evil.com:1', 'nonsense']) {
      expect(imageServiceConfig({ TUGPT_IMAGE_SERVICE_URL: url, TUGPT_IMAGE_SERVICE_TOKEN_FILE: '/etc/x' })).toBeNull();
    }
    expect(imageServiceConfig({ TUGPT_IMAGE_SERVICE_URL: 'http://127.0.0.1:1', TUGPT_IMAGE_SERVICE_TOKEN_FILE: 'relative/token' })).toBeNull();
    expect(imageServiceConfig({})).toBeNull();
  });
});

describe('ImageServiceClient', () => {
  it('submits with the bearer token and the strict wire shape, never following redirects', async () => {
    const fetchImpl = vi.fn(async () => json({ id: ID, status: 'queued', progress: null, seconds: null, error: null }, 202));
    const job = await client(fetchImpl).submit({ id: ID, organizationId: ORG, prompt: 'a cat', width: 1024, height: 1024, seed: 7 });
    expect(job).toEqual({ id: ID, status: 'queued', progress: 0, seconds: null, error: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:18766/jobs');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ id: ID, organization_id: ORG, prompt: 'a cat', width: 1024, height: 1024, seed: 7 });
  });

  it('maps service errors to codes and never puts the token in an error', async () => {
    const cases: [Response, string][] = [
      [json({ detail: 'ORGANIZATION_BUSY' }, 429), 'ORGANIZATION_BUSY'],
      [json({ detail: 'QUEUE_FULL' }, 429), 'QUEUE_FULL'],
      [json({ detail: 'MODEL_NOT_READY' }, 503), 'MODEL_NOT_READY'],
      [json({ error: 'UNAUTHORIZED' }, 401), 'UNAVAILABLE'],
      [json({ detail: 'JOB_NOT_FOUND' }, 404), 'NOT_FOUND'],
      [json({ detail: 'RESULT_EXPIRED' }, 410), 'RESULT_EXPIRED'],
      [new Response('<html>', { status: 502 }), 'UNAVAILABLE'],
    ];
    for (const [res, code] of cases) {
      const err = await client(async () => res).status(ID, ORG).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImageServiceError);
      expect((err as ImageServiceError).code).toBe(code);
      expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(TOKEN);
    }
  });

  it('treats network failures and unreadable or malformed tokens as unavailable or not configured', async () => {
    await expect(client(async () => { throw new Error(`connect ECONNREFUSED Bearer ${TOKEN}`); }).status(ID, ORG)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
    await expect(client(async () => json({}), 'short').status(ID, ORG)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    const unreadable = new ImageServiceClient(config, { readToken: async () => { throw new Error('EACCES'); } });
    await expect(unreadable.health()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('rejects malformed or mismatched job payloads (untrusted output)', () => {
    expect(() => parseGpuJob({ id: ID, status: 'done' })).toThrow(ImageServiceError);
    expect(() => parseGpuJob({ id: ID, status: 'queued', progress: 500 })).toThrow(ImageServiceError);
    expect(() => parseGpuJob({ id: ID, status: 'failed', error: '<script>' })).toThrow(ImageServiceError);
    expect(() => parseGpuJob({ id: ORG, status: 'queued' }, ID)).toThrow(ImageServiceError);
    expect(parseGpuJob({ id: ID, status: 'completed', progress: 100, seconds: 2.5, error: null }, ID).seconds).toBe(2.5);
  });

  it('scopes status, cancel and result calls by organization', async () => {
    const fetchImpl = vi.fn(async () => json({ id: ID, status: 'processing', progress: 40, seconds: null, error: null }));
    await client(fetchImpl).status(ID, ORG);
    await client(fetchImpl).cancel(ID, ORG);
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([`http://127.0.0.1:18766/jobs/${ID}?organization_id=${ORG}`, `http://127.0.0.1:18766/jobs/${ID}/cancel?organization_id=${ORG}`]);
  });

  it('only returns real PNG bytes', async () => {
    const ok = await client(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } })).result(ID, ORG);
    expect(Array.from(ok.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await expect(client(async () => new Response('<svg onload=alert(1)>', { headers: { 'content-type': 'image/png' } })).result(ID, ORG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    await expect(client(async () => new Response(PNG, { headers: { 'content-type': 'text/html' } })).result(ID, ORG)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('requires the image capability in health', async () => {
    await expect(client(async () => json({ ready: true, model: 'Tongyi-MAI/Z-Image-Turbo', capabilities: ['chat'] })).health()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    await expect(client(async () => json({ ready: true, model: 'Tongyi-MAI/Z-Image-Turbo', capabilities: ['image.generate'] })).health()).resolves.toEqual({ ready: true, model: 'Tongyi-MAI/Z-Image-Turbo' });
  });

  it('knows the supported sizes', () => {
    expect(sizeOf(1280, 720)).toBe('landscape');
    expect(sizeOf(999, 999)).toBeNull();
  });
});
