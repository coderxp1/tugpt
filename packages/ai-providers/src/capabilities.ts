/** Capability-specific contracts. Existing text/transcription adapters stay intact. */
export interface ImageSubmission {
  readonly jobId: string;
  readonly organizationId: string;
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly seed?: number;
}
export interface ImageJobState {
  readonly id: string;
  readonly status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  readonly progress: number;
  readonly seconds: number | null;
}
export interface ImageProvider {
  submit(input: ImageSubmission, signal?: AbortSignal): Promise<ImageJobState>;
  status(jobId: string, organizationId: string, signal?: AbortSignal): Promise<ImageJobState>;
  cancel(jobId: string, organizationId: string, signal?: AbortSignal): Promise<ImageJobState>;
  result(jobId: string, organizationId: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface EmbeddingProvider {
  embed(texts: readonly string[], options: { organizationId: string; signal?: AbortSignal }): Promise<{
    model: string; revision: string; dimensions: number; vectors: readonly (readonly number[])[];
  }>;
}
export type Capability = 'text.generate' | 'image.generate' | 'embedding.generate' | 'audio.transcribe';
export interface CapabilityRoute {
  readonly capability: Capability;
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly external: boolean;
}
/** Explicit config only. No implicit external fallback or environment defaults. */
export function resolveCapabilityRoute(
  routes: readonly CapabilityRoute[], capability: Capability, allowExternal = false
): CapabilityRoute {
  const matches = routes.filter((r) => r.capability === capability && r.enabled);
  if (matches.length !== 1) throw new Error('CAPABILITY_ROUTE_NOT_UNIQUE');
  const route = matches[0]!;
  if (route.external && !allowExternal) throw new Error('EXTERNAL_PROVIDER_NOT_APPROVED');
  if (!route.provider.trim() || !route.model.trim()) throw new Error('INVALID_CAPABILITY_ROUTE');
  return route;
}
/** Next feature: tenant-scoped semantic knowledge retrieval. Validate vectors
 * and filter ownership BEFORE ranking; never mix embedding revisions. */
export function rankKnowledgeVectors(
  query: readonly number[], organizationId: string, modelRevision: string,
  entries: readonly { id: string; organizationId: string; modelRevision: string; vector: readonly number[] }[],
  limit = 5
): { id: string; score: number }[] {
  if (!organizationId || !modelRevision || !Number.isInteger(limit) || limit < 1 || limit > 50 || query.length < 1 || query.length > 4096 || query.some((n) => !Number.isFinite(n))) {
    throw new Error('INVALID_RETRIEVAL_INPUT');
  }
  const norm = Math.sqrt(query.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || !norm) throw new Error('INVALID_RETRIEVAL_INPUT');
  return entries.filter((e) => e.organizationId === organizationId && e.modelRevision === modelRevision)
    .flatMap((e) => {
      if (e.vector.length !== query.length || e.vector.some((n) => !Number.isFinite(n))) return [];
      const magnitude = Math.sqrt(e.vector.reduce((sum, n) => sum + n * n, 0));
      if (!magnitude || !Number.isFinite(magnitude)) return [];
      const score = query.reduce((sum, n, i) => sum + n * e.vector[i]!, 0) / norm / magnitude;
      return Number.isFinite(score) ? [{ id: e.id, score }] : [];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
