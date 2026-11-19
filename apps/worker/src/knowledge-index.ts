/**
 * @file knowledge-index.ts
 * @description Entry point for the workspace knowledge (document processing) worker.
 *
 * Separate process: PDF parsing and embedding calls are slow and must not hold
 * up the message or draft loops. Needs the Supabase URL, the service-role key
 * and the blob store configuration (TUGPT_FILE_STORAGE...). Embeddings are
 * optional (TUGPT_EMBEDDINGS_URL/_MODEL/_DIMS[/_API_KEY]); without them
 * documents are indexed for keyword search only.
 */
import { hostname } from 'node:os';
import { createAdminSupabaseClient } from '@tugpt/database';
import { Logger } from '@tugpt/observability';
import { configuredBlobStore, configuredEmbeddings, embeddingsConfig } from '@tugpt/workspace-core';
import { pdfExtractor } from '@tugpt/workspace-core/pdf';
import { knowledgeLogFrom, runKnowledgeWorker } from './knowledge-worker.js';
import type { RpcClient } from './workspace-rpc.js';

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const store = configuredBlobStore();
  if (!supabaseUrl || !serviceRoleKey || !store) {
    console.error(JSON.stringify({ error: 'Missing required environment variables', required: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TUGPT_FILE_STORAGE (+ settings)'] }));
    process.exit(1);
  }
  if (process.env.TUGPT_EMBEDDINGS_URL && !embeddingsConfig()) {
    console.error(JSON.stringify({ error: 'Invalid embeddings configuration (https, or http on loopback; model; dims 1-4096)' }));
    process.exit(1);
  }
  const log = knowledgeLogFrom(new Logger({ service: 'workspace-knowledge-worker' }));
  const db = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as unknown as RpcClient;
  const workerId = `knowledge-${hostname()}-${process.pid}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
  const embeddings = configuredEmbeddings();
  log.info('knowledge.worker_started', { storage: store.kind, embeddings: embeddings ? embeddings.model : 'disabled' });

  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());
  process.on('SIGTERM', () => abort.abort());
  await runKnowledgeWorker({ db, store, pdf: pdfExtractor, embeddings, log, leaseSeconds: 300 }, {
    workerId,
    batchSize: Number.parseInt(process.env.KNOWLEDGE_WORKER_BATCH || '2', 10) || 2,
    pollIntervalMs: Number.parseInt(process.env.KNOWLEDGE_WORKER_POLL_INTERVAL_MS || '5000', 10) || 5000,
  }, abort.signal);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: 'Knowledge worker fatal error', message: (err as Error).message }));
  process.exit(1);
});
