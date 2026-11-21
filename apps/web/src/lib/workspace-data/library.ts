/**
 * Library: knowledge collections, documents, indexing and search
 * (20261119100004; async processing 20261120100002; hybrid search 20261120100001). Authorization lives in RLS and the SECURITY DEFINER
 * helpers can_read_collection / can_write_collection; this module only shapes
 * requests and responses. Search is evaluated per chunk under the caller's
 * RLS at query time, so access changes apply to the very next query.
 */
import type { Collection, CollectionDetail, FileVisibility, LibraryDocument, SearchHit } from './contracts';
import { check, num, oneOf, optStr, rows, str, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';
import { FILE_COLS, toFile } from './files';
import { cleanName, isUuid, optionalText } from './http';

const COLLECTION_COLS = 'id,owner_user_id,name,description,visibility,created_at,updated_at';
const DOCUMENT_COLS = 'id,collection_id,file_id,title,status,error_code,chunk_count,indexed_at,created_at,processing_attempts,next_attempt_at';

export function toCollection(row: unknown, userId: string): Collection {
  const r = row as Record<string, unknown>;
  return {
    id: str(r.id), name: str(r.name), description: optStr(r.description), visibility: oneOf(r.visibility, ['private', 'organization'] as const),
    ownedByMe: str(r.owner_user_id) === userId, createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}
export function toDocument(row: unknown): LibraryDocument {
  const r = row as Record<string, unknown>;
  return {
    id: str(r.id), collectionId: str(r.collection_id), fileId: str(r.file_id), title: str(r.title),
    status: oneOf(r.status, ['pending', 'indexing', 'ready', 'failed', 'unsupported'] as const), errorCode: optStr(r.error_code),
    chunkCount: num(r.chunk_count), indexedAt: optStr(r.indexed_at), createdAt: str(r.created_at),
    processingAttempts: r.processing_attempts === undefined ? 0 : num(r.processing_attempts), nextAttemptAt: optStr(r.next_attempt_at),
  };
}

export function parseCollectionInput(body: Record<string, unknown>, partial: boolean): { name?: string; description?: string | null; visibility?: FileVisibility } {
  const out: { name?: string; description?: string | null; visibility?: FileVisibility } = {};
  if ('name' in body || !partial) out.name = cleanName(body.name, 120);
  if ('description' in body) out.description = optionalText(body.description, 1000);
  if ('visibility' in body) {
    if (body.visibility !== 'private' && body.visibility !== 'organization') throw new WorkspaceError(400, 'INVALID_REQUEST');
    out.visibility = body.visibility;
  }
  if (partial && Object.keys(out).length === 0) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return out;
}

export async function listCollections(db: WorkspaceDb, organizationId: string, userId: string): Promise<Collection[]> {
  return rows(await db.from('knowledge_collections').select(COLLECTION_COLS).eq('organization_id', organizationId)
    .order('updated_at', { ascending: false }).limit(200)).map((r) => toCollection(r, userId));
}

export async function createCollection(db: WorkspaceDb, organizationId: string, userId: string, input: { name?: string; description?: string | null; visibility?: FileVisibility }): Promise<Collection> {
  return toCollection(check(await db.from('knowledge_collections').insert({
    organization_id: organizationId, owner_user_id: userId, name: input.name, description: input.description ?? null, visibility: input.visibility ?? 'private',
  }).select(COLLECTION_COLS).single()), userId);
}

export async function getCollection(db: WorkspaceDb, organizationId: string, userId: string, id: string): Promise<CollectionDetail> {
  const c = check(await db.from('knowledge_collections').select(COLLECTION_COLS).eq('id', id).eq('organization_id', organizationId).maybeSingle());
  if (!c) throw new WorkspaceError(404, 'NOT_FOUND');
  const documents = rows(await db.from('knowledge_documents').select(DOCUMENT_COLS).eq('collection_id', id).eq('organization_id', organizationId)
    .order('created_at', { ascending: false }).limit(500)).map(toDocument);
  return { collection: toCollection(c, userId), documents };
}

export async function updateCollection(db: WorkspaceDb, organizationId: string, userId: string, id: string, patch: { name?: string; description?: string | null; visibility?: FileVisibility }): Promise<Collection> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.visibility !== undefined) values.visibility = patch.visibility;
  const data = check(await db.from('knowledge_collections').update(values).eq('id', id).eq('organization_id', organizationId).select(COLLECTION_COLS).maybeSingle());
  if (!data) throw await collectionRefusal(db, organizationId, id);
  return toCollection(data, userId);
}

export async function deleteCollection(db: WorkspaceDb, organizationId: string, id: string): Promise<void> {
  const deleted = rows(await db.from('knowledge_collections').delete().eq('id', id).eq('organization_id', organizationId).select('id'));
  if (deleted.length > 0) return;
  throw await collectionRefusal(db, organizationId, id);
}

/**
 * A write that RLS let touch no row: 403 FORBIDDEN if the caller can still READ the row (it
 * exists, they may not change it), otherwise 404 NOT_FOUND (missing, already removed, or not
 * theirs to see; no enumeration). Clients may treat 404 on a remove as "already removed";
 * 403 is never that (Q-14).
 */
function refusal(visible: unknown): WorkspaceError {
  return visible ? new WorkspaceError(403, 'FORBIDDEN') : new WorkspaceError(404, 'NOT_FOUND');
}
async function collectionRefusal(db: WorkspaceDb, organizationId: string, id: string): Promise<WorkspaceError> {
  return refusal(check(await db.from('knowledge_collections').select('id').eq('id', id).eq('organization_id', organizationId).maybeSingle()));
}

/**
 * Adds an uploaded (ready, readable) file to a writable collection.
 *
 * Never indexes in the request (Q-8): the insert trigger (20261120100002)
 * enqueues a job and the knowledge worker extracts, chunks and embeds. A new
 * document is therefore always returned as `pending` with `created: true`;
 * clients poll the collection until it is `ready` / `failed` / `unsupported`.
 *
 * Idempotent for retries. The database allows one document per file and one
 * per content hash in a collection (20261120100006). When either key already
 * exists, the existing document is returned unchanged with `created: false`:
 * retrying a lost response, or re-uploading the same bytes under a new file
 * id, never produces a second document. A unique violation implies the row
 * passed the documents_insert policy (RLS WITH CHECK runs before index
 * checks), i.e. the caller may write, and so read, this collection.
 * Dedupe keys are per collection, and a collection belongs to exactly one
 * tenant: identical bytes in another collection or tenant are a new document.
 */
export async function addDocument(db: WorkspaceDb, organizationId: string, userId: string, collectionId: string,
  input: { fileId: string; title?: string | null }): Promise<{ document: LibraryDocument; created: boolean }> {
  const fileRow = check(await db.from('workspace_files').select(FILE_COLS).eq('id', input.fileId).eq('organization_id', organizationId).maybeSingle());
  if (!fileRow) throw new WorkspaceError(404, 'NOT_FOUND');
  const file = toFile(fileRow, userId);
  if (file.status !== 'ready') throw new WorkspaceError(409, 'CONFLICT');
  // Two attempts: a unique violation whose winner is deleted before we can read it
  // (concurrent remove) leaves the slot free again, so the second insert succeeds.
  for (let attempt = 0; attempt < ADD_DOCUMENT_ATTEMPTS; attempt++) {
    const inserted = await db.from('knowledge_documents').insert({
      organization_id: organizationId, collection_id: collectionId, file_id: file.id, added_by: userId, title: input.title || file.filename,
    }).select(DOCUMENT_COLS).single();
    if (inserted.error?.code === '42501') {
      // Readable but not writable => 403; not even readable => indistinguishable from missing.
      const visible = check(await db.from('knowledge_collections').select('id').eq('id', collectionId).eq('organization_id', organizationId).maybeSingle());
      throw new WorkspaceError(visible ? 403 : 404, visible ? 'FORBIDDEN' : 'NOT_FOUND');
    }
    if (inserted.error?.code !== '23505') return { document: toDocument(check(inserted)), created: true };
    const existing = await existingDocument(db, organizationId, collectionId, file.id, (fileRow as { sha256?: unknown }).sha256);
    if (existing) return { document: existing, created: false };
  }
  // Only reachable if the conflicting row keeps disappearing between insert and read.
  throw new WorkspaceError(409, 'ALREADY_EXISTS');
}

export const ADD_DOCUMENT_ATTEMPTS = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The document that blocked an insert: same file first, else same content (the two unique keys). */
async function existingDocument(db: WorkspaceDb, organizationId: string, collectionId: string, fileId: string, sha: unknown): Promise<LibraryDocument | null> {
  const inCollection = () => db.from('knowledge_documents').select(DOCUMENT_COLS).eq('organization_id', organizationId).eq('collection_id', collectionId);
  const byFile = check(await inCollection().eq('file_id', fileId).maybeSingle());
  if (byFile) return toDocument(byFile);
  if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) return null;
  const byContent = check(await inCollection().eq('content_sha256', sha).maybeSingle());
  return byContent ? toDocument(byContent) : null;
}

/** Re-queues processing (resets attempts). Writable collections only; enforced by request_document_reindex. */
export async function reindexDocument(db: WorkspaceDb, organizationId: string, collectionId: string, documentId: string): Promise<LibraryDocument> {
  const doc = check(await db.from('knowledge_documents').select('id').eq('id', documentId).eq('collection_id', collectionId).eq('organization_id', organizationId).maybeSingle());
  if (!doc) throw new WorkspaceError(404, 'NOT_FOUND');
  check(await db.rpc('request_document_reindex', { p_organization_id: organizationId, p_document_id: documentId }));
  return toDocument(check(await db.from('knowledge_documents').select(DOCUMENT_COLS).eq('id', documentId).eq('organization_id', organizationId).single()));
}

export async function removeDocument(db: WorkspaceDb, organizationId: string, collectionId: string, documentId: string): Promise<void> {
  const deleted = rows(await db.from('knowledge_documents').delete().eq('id', documentId).eq('collection_id', collectionId).eq('organization_id', organizationId).select('id'));
  if (deleted.length > 0) return;
  // Readable (documents_read = can_read_collection) but not writable => 403; gone or invisible => 404.
  throw refusal(check(await db.from('knowledge_documents').select('id').eq('id', documentId).eq('collection_id', collectionId).eq('organization_id', organizationId).maybeSingle()));
}

export function parseCollectionIds(v: string | null): string[] | null {
  if (v === null || v === '') return null;
  const ids = v.split(',');
  if (ids.length > 50 || !ids.every(isUuid)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return [...new Set(ids.map((i) => i.toLowerCase()))];
}

export interface QueryEmbedder { readonly model: string; embed(inputs: readonly string[], signal?: AbortSignal): Promise<number[][]> }

function toHit(row: unknown): SearchHit {
  const r = row as Record<string, unknown>;
  const real = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    chunkId: str(r.chunk_id), documentId: str(r.document_id), collectionId: str(r.collection_id), fileId: str(r.file_id),
    title: str(r.title), ordinal: num(r.ordinal), snippet: str(r.snippet), rank: real(r.rank) ?? 0,
    match: oneOf(r.match, ['keyword', 'semantic', 'hybrid'] as const), keywordScore: real(r.fts_score), semanticScore: real(r.semantic_score),
  };
}

/**
 * Hybrid retrieval (search_knowledge_hybrid, SECURITY INVOKER: chunk and
 * embedding RLS decide per row at query time). When an embedder is configured
 * the query is embedded and fused with full-text ranking (RRF); if embedding
 * fails, search degrades to keyword-only instead of failing, and `semantic`
 * in the result says which mode ran.
 */
export async function searchLibrary(db: WorkspaceDb, organizationId: string, q: string, collectionIds: string[] | null, limit: number,
  embedder: QueryEmbedder | null = null, signal?: AbortSignal, embedText?: string): Promise<{ hits: SearchHit[]; semantic: boolean }> {
  const query = q.trim();
  if (!query) throw new WorkspaceError(400, 'QUERY_REQUIRED');
  if (Array.from(query).length > 200) throw new WorkspaceError(400, 'QUERY_TOO_LONG');
  let vector: string | null = null;
  if (embedder) {
    try {
      const [v] = await embedder.embed([embedText?.trim() || query], signal);
      if (v && v.length > 0) vector = `[${v.map((x) => (Number.isFinite(x) ? String(x) : '0')).join(',')}]`;
    } catch { vector = null; /* embeddings unavailable: keyword-only */ }
  }
  const hits = rows(await db.rpc('search_knowledge_hybrid', {
    p_organization_id: organizationId, p_query: query, p_query_embedding: vector, p_embedding_model: vector ? embedder!.model : null,
    p_collection_ids: collectionIds, p_limit: limit,
  })).map(toHit);
  return { hits, semantic: vector !== null };
}

// ---------------------------------------------------------------- conversation links
export async function listThreadCollections(db: WorkspaceDb, organizationId: string, userId: string, threadId: string): Promise<Collection[]> {
  const links = rows(await db.from('chat_thread_collections').select('collection_id').eq('thread_id', threadId).eq('organization_id', organizationId).limit(100));
  const ids = links.map((l) => str((l as Record<string, unknown>).collection_id));
  if (ids.length === 0) return [];
  // Collections the caller can no longer read are silently dropped (permissions at retrieval time).
  return rows(await db.from('knowledge_collections').select(COLLECTION_COLS).eq('organization_id', organizationId).in('id', ids).limit(100))
    .map((r) => toCollection(r, userId));
}

export async function linkCollection(db: WorkspaceDb, organizationId: string, userId: string, threadId: string, collectionId: string): Promise<void> {
  const r = await db.from('chat_thread_collections').insert({ thread_id: threadId, collection_id: collectionId, organization_id: organizationId, linked_by: userId });
  if (r.error?.code === '23505') return; // already linked: idempotent
  if (r.error?.code === '42501') throw new WorkspaceError(404, 'NOT_FOUND'); // unreadable collection looks missing
  check(r);
}

export async function unlinkCollection(db: WorkspaceDb, organizationId: string, threadId: string, collectionId: string): Promise<void> {
  const deleted = rows(await db.from('chat_thread_collections').delete().eq('thread_id', threadId).eq('collection_id', collectionId).eq('organization_id', organizationId).select('thread_id'));
  if (deleted.length === 0) throw new WorkspaceError(404, 'NOT_FOUND');
}
