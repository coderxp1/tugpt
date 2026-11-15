/**
 * Server-only client for TuGPT's private GPU image service.
 *
 * The service is reachable only through a restricted SSH tunnel on the web
 * host's loopback (docs/create-images.md). Its bearer token lives in a
 * root-only file named by TUGPT_IMAGE_SERVICE_TOKEN_FILE and is read per call,
 * so rotation needs no restart. The token is never logged, never returned and
 * never part of an error message. Every response is untrusted input and is
 * validated before use.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const IMAGE_SIZES = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
} as const;
export type ImageSize = keyof typeof IMAGE_SIZES;
export const isImageSize = (v: unknown): v is ImageSize => typeof v === 'string' && Object.hasOwn(IMAGE_SIZES, v);
export function sizeOf(width: number, height: number): ImageSize | null {
  for (const [k, s] of Object.entries(IMAGE_SIZES)) if (s.width === width && s.height === height) return k as ImageSize;
  return null;
}

export type GpuJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
const GPU_STATUSES: readonly GpuJobStatus[] = ['queued', 'processing', 'completed', 'failed', 'cancelled'];
export interface GpuJob {
  readonly id: string;
  readonly status: GpuJobStatus;
  readonly progress: number;
  readonly seconds: number | null;
  readonly error: string | null;
}
export interface GpuHealth { readonly ready: boolean; readonly model: string }

export type ImageServiceErrorCode =
  | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'MODEL_NOT_READY' | 'ORGANIZATION_BUSY' | 'QUEUE_FULL'
  | 'STORAGE_LIMIT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'RESULT_NOT_READY' | 'RESULT_EXPIRED'
  | 'CONFLICT' | 'BAD_RESPONSE';
export class ImageServiceError extends Error {
  constructor(readonly code: ImageServiceErrorCode, readonly status?: number) {
    super(code);
    this.name = 'ImageServiceError';
  }
}

export interface ImageServiceConfig { readonly baseUrl: string; readonly tokenFile: string }

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Null when not configured or misconfigured: the GPU must be a loopback HTTP endpoint (the tunnel). */
export function imageServiceConfig(env: Readonly<Record<string, string | undefined>> = process.env): ImageServiceConfig | null {
  const raw = env.TUGPT_IMAGE_SERVICE_URL;
  const tokenFile = env.TUGPT_IMAGE_SERVICE_TOKEN_FILE;
  if (!raw || !tokenFile || !isAbsolute(tokenFile)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) return null;
  return { baseUrl: url.origin, tokenFile };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface ImageServiceDeps {
  readonly fetchImpl?: FetchLike;
  readonly readToken?: (file: string) => Promise<string>;
}

const TOKEN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const defaultReadToken = async (file: string) => (await readFile(file, 'utf8')).trim();

export function parseGpuJob(value: unknown, expectedId?: string): GpuJob {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') throw new ImageServiceError('BAD_RESPONSE');
  const { id, status, progress, seconds, error } = v;
  if (typeof id !== 'string' || !UUID.test(id) || (expectedId && id.toLowerCase() !== expectedId.toLowerCase())) throw new ImageServiceError('BAD_RESPONSE');
  if (typeof status !== 'string' || !GPU_STATUSES.includes(status as GpuJobStatus)) throw new ImageServiceError('BAD_RESPONSE');
  const p = progress === null || progress === undefined ? 0 : progress;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) throw new ImageServiceError('BAD_RESPONSE');
  if (!(seconds === null || seconds === undefined || (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600))) throw new ImageServiceError('BAD_RESPONSE');
  if (!(error === null || error === undefined || (typeof error === 'string' && CODE.test(error)))) throw new ImageServiceError('BAD_RESPONSE');
  return { id, status: status as GpuJobStatus, progress: Math.round(p), seconds: (seconds as number | null | undefined) ?? null, error: (error as string | null | undefined) ?? null };
}

const KNOWN: Readonly<Record<string, ImageServiceErrorCode>> = {
  MODEL_NOT_READY: 'MODEL_NOT_READY', ORGANIZATION_BUSY: 'ORGANIZATION_BUSY', QUEUE_FULL: 'QUEUE_FULL',
  STORAGE_LIMIT: 'STORAGE_LIMIT', INVALID_REQUEST: 'INVALID_REQUEST', JOB_NOT_FOUND: 'NOT_FOUND',
  RESULT_NOT_READY: 'RESULT_NOT_READY', RESULT_EXPIRED: 'RESULT_EXPIRED', IDEMPOTENCY_CONFLICT: 'CONFLICT',
};

async function errorFrom(res: Response): Promise<ImageServiceError> {
  let detail: unknown;
  try { const body = await res.json() as Record<string, unknown>; detail = body?.detail ?? body?.error; } catch { /* non-JSON */ }
  const mapped = typeof detail === 'string' ? KNOWN[detail] : undefined;
  if (mapped) return new ImageServiceError(mapped, res.status);
  // 401 means our token is wrong: an operator problem, reported as unavailable, never echoed.
  if (res.status === 401 || res.status >= 500) return new ImageServiceError('UNAVAILABLE', res.status);
  if (res.status === 404) return new ImageServiceError('NOT_FOUND', 404);
  if (res.status === 422) return new ImageServiceError('INVALID_REQUEST', 422);
  return new ImageServiceError('BAD_RESPONSE', res.status);
}

export interface SubmitInput {
  readonly id: string; readonly organizationId: string; readonly prompt: string;
  readonly width: number; readonly height: number; readonly seed: number;
}

export class ImageServiceClient {
  private readonly fetchImpl: FetchLike;
  private readonly readToken: (file: string) => Promise<string>;

  constructor(private readonly config: ImageServiceConfig, deps: ImageServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
    this.readToken = deps.readToken ?? defaultReadToken;
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number; accept?: string }): Promise<Response> {
    let token: string;
    try { token = await this.readToken(this.config.tokenFile); } catch { throw new ImageServiceError('NOT_CONFIGURED'); }
    if (!TOKEN.test(token)) throw new ImageServiceError('NOT_CONFIGURED');
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: init.accept ?? 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.fetchImpl(this.config.baseUrl + path, {
        method: init.method, headers, cache: 'no-store', redirect: 'error',
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch {
      throw new ImageServiceError('UNAVAILABLE');
    }
  }

  private async json(res: Response): Promise<unknown> {
    if (!res.ok) throw await errorFrom(res);
    if (!res.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ImageServiceError('BAD_RESPONSE', res.status);
    try { return await res.json(); } catch { throw new ImageServiceError('BAD_RESPONSE', res.status); }
  }

  async health(): Promise<GpuHealth> {
    const body = await this.json(await this.call('/health', { method: 'GET', timeoutMs: 4000 })) as Record<string, unknown> | null;
    const caps = body?.capabilities;
    if (typeof body?.ready !== 'boolean' || typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,119}$/.test(body.model) ||
        !Array.isArray(caps) || !caps.includes('image.generate')) throw new ImageServiceError('BAD_RESPONSE');
    return { ready: body.ready, model: body.model };
  }

  async submit(input: SubmitInput): Promise<GpuJob> {
    const res = await this.call('/jobs', {
      method: 'POST', timeoutMs: 10000,
      body: { id: input.id, organization_id: input.organizationId, prompt: input.prompt, width: input.width, height: input.height, seed: input.seed },
    });
    return parseGpuJob(await this.json(res), input.id);
  }

  async status(id: string, organizationId: string): Promise<GpuJob> {
    const res = await this.call(`/jobs/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(organizationId)}`, { method: 'GET', timeoutMs: 8000 });
    return parseGpuJob(await this.json(res), id);
  }

  async cancel(id: string, organizationId: string): Promise<GpuJob> {
    const res = await this.call(`/jobs/${encodeURIComponent(id)}/cancel?organization_id=${encodeURIComponent(organizationId)}`, { method: 'POST', timeoutMs: 8000 });
    return parseGpuJob(await this.json(res), id);
  }

  /** The finished PNG. Size-capped and magic-checked: only a real PNG ever reaches the browser. */
  async result(id: string, organizationId: string): Promise<Uint8Array> {
    const res = await this.call(`/jobs/${encodeURIComponent(id)}/result?organization_id=${encodeURIComponent(organizationId)}`, { method: 'GET', timeoutMs: 30000, accept: 'image/png' });
    if (!res.ok) throw await errorFrom(res);
    if (res.headers.get('content-type')?.toLowerCase() !== 'image/png') throw new ImageServiceError('BAD_RESPONSE', res.status);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_PNG_BYTES) throw new ImageServiceError('BAD_RESPONSE', res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_PNG_BYTES || bytes.byteLength < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
      throw new ImageServiceError('BAD_RESPONSE', res.status);
    }
    return bytes;
  }
}

/** The configured client, or null when image generation is not set up on this host. */
export function configuredImageService(deps?: ImageServiceDeps): ImageServiceClient | null {
  const config = imageServiceConfig();
  return config ? new ImageServiceClient(config, deps) : null;
}
