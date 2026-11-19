/**
 * Query embedder for hybrid search and agent retrieval. Same configuration as
 * the knowledge worker (TUGPT_EMBEDDINGS_URL/_MODEL/_DIMS/_API_KEY, see
 * @tugpt/workspace-core/embeddings). Not configured => null => keyword-only.
 * Queries are embedded with a short timeout so search latency stays bounded.
 */
import { EmbeddingsClient, embeddingsConfig } from '@tugpt/workspace-core/embeddings';
import type { QueryEmbedder } from './library';

let cached: { key: string; client: EmbeddingsClient | null } | undefined;
let override: QueryEmbedder | null | undefined;

export function configuredQueryEmbedder(env: Readonly<Record<string, string | undefined>> = process.env): QueryEmbedder | null {
  if (override !== undefined) return override;
  const key = [env.TUGPT_EMBEDDINGS_URL, env.TUGPT_EMBEDDINGS_MODEL, env.TUGPT_EMBEDDINGS_DIMS, env.TUGPT_EMBEDDINGS_API_KEY ? 'k' : ''].join('|');
  if (!cached || cached.key !== key) {
    const cfg = embeddingsConfig(env);
    cached = { key, client: cfg ? new EmbeddingsClient(cfg, undefined, 5_000) : null };
  }
  return cached.client;
}

/** Tests only: force an embedder (or null); undefined restores env-based configuration. */
export function setQueryEmbedderForTests(e: QueryEmbedder | null | undefined): void { override = e; }
