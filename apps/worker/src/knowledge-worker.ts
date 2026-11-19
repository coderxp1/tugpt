/**
 * @file knowledge-worker.ts
 * @description Turns uploaded workspace files into searchable knowledge.
 *
 * Loop: claim_document_jobs (lease) -> read blob -> verify sha256 -> extract
 * (text, DOCX, XLSX, PDF) -> chunk -> optional embeddings -> complete_document_job.
 *
 * Failure policy
 *   * Storage or database hiccups, and embedding outages on early attempts:
 *     fail_document_job(retryable) -> the database re-queues with backoff
 *     (30 s doubling, max 5 attempts, then dead letter).
 *   * Deterministic outcomes (unsupported type, encrypted PDF, no text layer,
 *     too large, empty, corrupt file, hash mismatch): completed as
 *     failed/unsupported with a code; retrying cannot help.
 *   * Embeddings still failing from attempt EMBEDDINGS_FALLBACK_ATTEMPT on:
 *     the document is indexed keyword-only (search keeps working); a reindex
 *     later adds vectors.
 *   * LEASE_LOST: another worker owns the job now; drop the result.
 *
 * Privacy: document text, filenames and blob bytes are never logged. Logged:
 * document id, organization id, attempt, outcome code, chunk count, timings.
 * Every database write goes through service_role RPCs that re-check the lease.
 */
import { createHash } from 'node:crypto';
import {
  blobKey, chunkText, extractDocument, toVectorLiteral, EmbeddingsError,
  type BlobStore, type EmbeddingsClient, type PdfExtractor,
} from '@tugpt/workspace-core';
import { callRpc, RpcError, type RpcClient } from './workspace-rpc.js';

export interface ClaimedDocumentJob {
  readonly document_id: string;
  readonly organization_id: string;
  readonly collection_id: string;
  readonly file_id: string;
  readonly media_type: string;
  readonly sha256: string | null;
  readonly size_bytes: number;
  readonly attempt: number;
  readonly lease_token: string;
}

export interface KnowledgeLog {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface KnowledgeDeps {
  readonly db: RpcClient;
  readonly store: BlobStore;
  readonly pdf?: PdfExtractor;
  readonly embeddings?: EmbeddingsClient | null;
  readonly log: KnowledgeLog;
  /** Lease length requested from claim_document_jobs and on each heartbeat. */
  readonly leaseSeconds?: number;
}

export type JobOutcome =
  | { readonly kind: 'ready'; readonly chunks: number; readonly embedded: boolean }
  | { readonly kind: 'failed' | 'unsupported'; readonly code: string }
  | { readonly kind: 'retry' | 'dead'; readonly code: string }
  | { readonly kind: 'lease_lost' };

export const EMBEDDINGS_FALLBACK_ATTEMPT = 3;
export const DEFAULT_LEASE_SECONDS = 300;

function sha256Hex(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function fail(deps: KnowledgeDeps, job: ClaimedDocumentJob, code: string, retryable: boolean): Promise<JobOutcome> {
  try {
    const status = await callRpc<string>(deps.db, 'fail_document_job', {
      p_document_id: job.document_id, p_lease_token: job.lease_token, p_error_code: code, p_retryable: retryable,
    });
    return { kind: status === 'dead' ? 'dead' : 'retry', code };
  } catch (e) {
    if (e instanceof RpcError && e.code === 'LEASE_LOST') return { kind: 'lease_lost' };
    throw e;
  }
}

async function complete(deps: KnowledgeDeps, job: ClaimedDocumentJob, args: {
  status: 'ready' | 'failed' | 'unsupported'; chunks?: string[]; code?: string; model?: string; vectors?: string[];
}): Promise<JobOutcome> {
  try {
    await callRpc<number>(deps.db, 'complete_document_job', {
      p_document_id: job.document_id, p_lease_token: job.lease_token, p_status: args.status,
      p_chunks: args.chunks ?? [], p_error_code: args.code ?? null,
      p_embedding_model: args.model ?? null, p_embeddings: args.vectors ?? null,
    });
  } catch (e) {
    if (e instanceof RpcError && e.code === 'LEASE_LOST') return { kind: 'lease_lost' };
    // Database refused the payload or is unreachable: let the queue retry.
    return fail(deps, job, e instanceof RpcError && e.code === 'DB_UNAVAILABLE' ? 'DB_UNAVAILABLE' : 'STORE_REJECTED', true);
  }
  return args.status === 'ready'
    ? { kind: 'ready', chunks: args.chunks?.length ?? 0, embedded: Boolean(args.vectors?.length) }
    : { kind: args.status, code: args.code ?? 'EXTRACTION_FAILED' };
}

/** Processes one claimed job end to end. Never throws for job-level problems. */
export async function processDocumentJob(deps: KnowledgeDeps, job: ClaimedDocumentJob, signal?: AbortSignal): Promise<JobOutcome> {
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  let leaseLost = false;
  // Heartbeat: keep the lease while extraction/embedding runs.
  const heartbeat = setInterval(() => {
    callRpc(deps.db, 'extend_document_job_lease', { p_document_id: job.document_id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds })
      .catch((e: unknown) => { if (e instanceof RpcError && e.code === 'LEASE_LOST') leaseLost = true; });
  }, Math.max(5, Math.floor(leaseSeconds / 3)) * 1000);
  heartbeat.unref?.();
  try {
    let bytes: Uint8Array | null;
    try { bytes = await deps.store.get(blobKey(job.organization_id, job.file_id)); } catch { return await fail(deps, job, 'STORAGE_UNAVAILABLE', true); }
    if (!bytes) return await complete(deps, job, { status: 'failed', code: 'FILE_MISSING' });
    if (!job.sha256 || sha256Hex(bytes) !== job.sha256) return await complete(deps, job, { status: 'failed', code: 'FILE_INTEGRITY_FAILED' });

    let extraction;
    try { extraction = await extractDocument(bytes, job.media_type, { pdf: deps.pdf }); } catch { extraction = { kind: 'failed', code: 'EXTRACTION_FAILED' } as const; }
    if (extraction.kind !== 'text') return await complete(deps, job, { status: extraction.kind, code: extraction.code });
    const chunks = chunkText(extraction.text);
    if (chunks.length === 0) return await complete(deps, job, { status: 'failed', code: 'EMPTY_DOCUMENT' });
    if (leaseLost || signal?.aborted) return { kind: 'lease_lost' };

    const emb = deps.embeddings ?? null;
    if (!emb) return await complete(deps, job, { status: 'ready', chunks });
    try {
      const vectors = await emb.embed(chunks, signal);
      if (leaseLost || signal?.aborted) return { kind: 'lease_lost' };
      return await complete(deps, job, { status: 'ready', chunks, model: emb.model, vectors: vectors.map(toVectorLiteral) });
    } catch (e) {
      const code = e instanceof EmbeddingsError ? e.code : 'EMBEDDINGS_UNAVAILABLE';
      if (job.attempt < EMBEDDINGS_FALLBACK_ATTEMPT) return await fail(deps, job, code, true);
      deps.log.warn('knowledge.embeddings_fallback_keyword_only', { documentId: job.document_id, organizationId: job.organization_id, attempt: job.attempt, code });
      return await complete(deps, job, { status: 'ready', chunks });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export interface KnowledgeWorkerOptions {
  readonly workerId: string;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
}

/** Claims and processes one batch; returns how many jobs were handled. */
export async function runKnowledgeBatch(deps: KnowledgeDeps, opts: KnowledgeWorkerOptions, signal?: AbortSignal): Promise<number> {
  const jobs = await callRpc<ClaimedDocumentJob[]>(deps.db, 'claim_document_jobs', {
    p_worker: opts.workerId, p_limit: opts.batchSize ?? 2, p_lease_seconds: deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  }) ?? [];
  for (const job of jobs) {
    if (signal?.aborted) break;
    const started = Date.now();
    const outcome = await processDocumentJob(deps, job, signal);
    const context = { documentId: job.document_id, organizationId: job.organization_id, attempt: job.attempt, ms: Date.now() - started, outcome: outcome.kind,
      ...(outcome.kind === 'ready' ? { chunks: outcome.chunks, embedded: outcome.embedded } : {}), ...('code' in outcome ? { code: outcome.code } : {}) };
    if (outcome.kind === 'ready') deps.log.info('knowledge.document_indexed', context);
    else if (outcome.kind === 'dead' || outcome.kind === 'lease_lost') deps.log.warn('knowledge.document_not_indexed', context);
    else deps.log.info('knowledge.document_not_indexed', context);
  }
  return jobs.length;
}

/** Poll loop: drains while there is work, sleeps when idle, stops on abort. */
export async function runKnowledgeWorker(deps: KnowledgeDeps, opts: KnowledgeWorkerOptions, signal: AbortSignal): Promise<void> {
  const idle = opts.pollIntervalMs ?? 5000;
  while (!signal.aborted) {
    let handled = 0;
    try { handled = await runKnowledgeBatch(deps, opts, signal); } catch (e) {
      deps.log.error('knowledge.batch_failed', { code: e instanceof RpcError ? e.code : 'UNEXPECTED' });
    }
    if (handled === 0) await new Promise<void>((r) => { const t = setTimeout(r, idle); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  }
}

/** Adapts @tugpt/observability's Logger (error takes an Error second) to KnowledgeLog. */
export function knowledgeLogFrom(logger: {
  info(m: string, c?: Record<string, unknown>): void; warn(m: string, c?: Record<string, unknown>): void;
  error(m: string, err?: Error, c?: Record<string, unknown>): void;
}): KnowledgeLog {
  return { info: (m, c) => logger.info(m, c), warn: (m, c) => logger.warn(m, c), error: (m, c) => logger.error(m, undefined, c) };
}
