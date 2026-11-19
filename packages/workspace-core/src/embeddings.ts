/**
 * Client for any OpenAI-compatible POST {base}/embeddings endpoint (vLLM,
 * TEI, Ollama's /v1, Langdock, OpenAI, ...).
 *
 *   TUGPT_EMBEDDINGS_URL      base URL ending at the API root, e.g. https://host/v1
 *                             (https, or http on loopback only)
 *   TUGPT_EMBEDDINGS_MODEL    model id
 *   TUGPT_EMBEDDINGS_DIMS     expected vector length (1..4096); responses are validated
 *   TUGPT_EMBEDDINGS_API_KEY  optional bearer token (never logged or returned)
 *
 * Not configured => embeddingsConfig() returns null and callers fall back to
 * full-text search only. Errors are generic codes; response bodies are never
 * surfaced because they can echo input text.
 */
export interface EmbeddingsConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly dims: number;
  readonly apiKey?: string;
}
export type EmbeddingsEnv = Readonly<Record<string, string | undefined>>;

export class EmbeddingsError extends Error {
  constructor(readonly code: 'EMBEDDINGS_UNAVAILABLE' | 'EMBEDDINGS_INVALID_RESPONSE') { super(code); this.name = 'EmbeddingsError'; }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const EMBEDDING_BATCH = 32;
export const MAX_EMBEDDING_DIMS = 4096;

export function embeddingsConfig(env: EmbeddingsEnv = process.env): EmbeddingsConfig | null {
  const raw = env.TUGPT_EMBEDDINGS_URL; const model = env.TUGPT_EMBEDDINGS_MODEL; const dimsRaw = env.TUGPT_EMBEDDINGS_DIMS;
  if (!raw || !model || !dimsRaw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))) return null;
  if (!/^[A-Za-z0-9._:/@-]{1,200}$/.test(model)) return null;
  if (!/^\d{1,4}$/.test(dimsRaw)) return null;
  const dims = Number(dimsRaw);
  if (dims < 1 || dims > MAX_EMBEDDING_DIMS) return null;
  return { baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, model, dims, apiKey: env.TUGPT_EMBEDDINGS_API_KEY || undefined };
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export class EmbeddingsClient {
  constructor(readonly config: EmbeddingsConfig, private readonly fetchFn: FetchFn = (u, i) => fetch(u, i), private readonly timeoutMs = 30_000) {}

  get model(): string { return this.config.model; }
  get dims(): number { return this.config.dims; }

  /** One vector per input, in input order. Batches internally. */
  async embed(inputs: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBEDDING_BATCH) out.push(...await this.batch(inputs.slice(i, i + EMBEDDING_BATCH), signal));
    return out;
  }

  private async batch(input: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.baseUrl}/embeddings`, {
        method: 'POST', headers, body: JSON.stringify({ model: this.config.model, input, encoding_format: 'float' }),
        redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch { throw new EmbeddingsError('EMBEDDINGS_UNAVAILABLE'); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new EmbeddingsError('EMBEDDINGS_UNAVAILABLE'); }
    let body: unknown;
    try { body = await res.json(); } catch { throw new EmbeddingsError('EMBEDDINGS_INVALID_RESPONSE'); }
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length !== input.length) throw new EmbeddingsError('EMBEDDINGS_INVALID_RESPONSE');
    const vectors: number[][] = new Array(input.length);
    data.forEach((d: { index?: unknown; embedding?: unknown }, pos) => {
      const index = typeof d?.index === 'number' ? d.index : pos;
      const e = d?.embedding;
      if (!Number.isInteger(index) || index < 0 || index >= input.length || vectors[index]) throw new EmbeddingsError('EMBEDDINGS_INVALID_RESPONSE');
      if (!Array.isArray(e) || e.length !== this.config.dims || !e.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new EmbeddingsError('EMBEDDINGS_INVALID_RESPONSE');
      }
      vectors[index] = e as number[];
    });
    return vectors;
  }
}

/** pgvector text literal ("[0.1,0.2,...]"). */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? String(x) : '0')).join(',')}]`;
}

export function configuredEmbeddings(env: EmbeddingsEnv = process.env, fetchFn?: FetchFn): EmbeddingsClient | null {
  const cfg = embeddingsConfig(env);
  return cfg ? new EmbeddingsClient(cfg, fetchFn) : null;
}
