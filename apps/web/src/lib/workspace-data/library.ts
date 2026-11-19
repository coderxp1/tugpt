/**
 * Library: knowledge collections, documents, indexing and search
 * (20261119100004). Authorization lives in RLS and the SECURITY DEFINER
 * helpers can_read_collection / can_write_collection; this module only shapes
 * requests and responses. Search is evaluated per chunk under the caller's
 * RLS at query time, so access changes apply to the very next query.
 */
import type { Collection, CollectionDetail, FileVisibility, LibraryDocument, SearchHit } from './contracts';
import { check, num, oneOf, optStr, rows, str, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';
import { chunkText, extractText, MAX_CHUNKS } from './extract';
import { FILE_COLS, sha256Hex, toFile } from './files';
import { cleanName, isUuid, optionalText } from './http';
import { blobKey, type BlobStore } from './storage';

const COLLECTION_COLS = 'id,owner_user_id,name,description,visibility,created_at,updated_at';
const DOCUMENT_COLS = 'id,collection_id,file_id,title,status,error_code,chunk_count,indexed_at,created_at';

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
  if (!data) throw new WorkspaceError(404, 'NOT_FOUND');
  return toCollection(data, userId);
}

export async function deleteCollection(db: WorkspaceDb, organizationId: string, id: string): Promise<void> {
  const deleted = rows(await db.from('knowledge_collections').delete().eq('id', id).eq('organization_id', organizationId).select('id'));
  if (deleted.length > 0) return;
  // RLS hid the row from DELETE: 403 if the caller can still read it, otherwise 404 (no enumeration).
  const visible = check(await db.from('knowledge_collections').select('id').eq('id', id).eq('organization_id', organizationId).maybeSingle());
  throw visible ? new WorkspaceError(403, 'FORBIDDEN') : new WorkspaceError(404, 'NOT_FOUND');
}

/** Extract, chunk and store; records the outcome on the document. Never throws for content problems. */
export async function indexDocument(db: WorkspaceDb, store: BlobStore, organizationId: string, userId: string, documentId: string, fileId: string): Promise<LibraryDocument> {
  const fileRow = check(await db.from('workspace_files').select(FILE_COLS).eq('id', fileId).eq('organization_id', organizationId).maybeSingle());
  if (!fileRow) throw new WorkspaceError(404, 'NOT_FOUND');
  const file = toFile(fileRow, userId);
  const write = async (status: string, chunks: string[], code: string | null) => {
    check(await db.rpc('replace_document_chunks', { p_organization_id: organizationId, p_document_id: documentId, p_status: status, p_chunks: chunks, p_error_code: code }));
  };
  const bytes = await store.get(blobKey(organizationId, fileId)).catch(() => { throw new WorkspaceError(503, 'STORAGE_UNAVAILABLE'); });
  if (!bytes || (file.sha256 && sha256Hex(bytes) !== file.sha256)) {
    await write('failed', [], 'INTEGRITY_CHECK_FAILED');
  } else {
    const extracted = extractText(bytes, file.mediaType);
    if (extracted.kind === 'text') {
      const chunks = chunkText(extracted.text);
      if (chunks.length > MAX_CHUNKS) await write('failed', [], 'DOCUMENT_TOO_LARGE');
      else await write('ready', chunks, null);
    } else await write(extracted.kind === 'unsupported' ? 'unsupported' : 'failed', [], extracted.code);
  }
  const doc = check(await db.from('knowledge_documents').select(DOCUMENT_COLS).eq('id', documentId).eq('organization_id', organizationId).single());
  return toDocument(doc);
}

export async function addDocument(db: WorkspaceDb, store: BlobStore, organizationId: string, userId: string, collectionId: string, input: { fileId: string; title?: string | null }): Promise<LibraryDocument> {
  const fileRow = check(await db.from('workspace_files').select(FILE_COLS).eq('id', input.fileId).eq('organization_id', organizationId).maybeSingle());
  if (!fileRow) throw new WorkspaceError(404, 'NOT_FOUND');
  const file = toFile(fileRow, userId);
  if (file.status !== 'ready') throw new WorkspaceError(409, 'CONFLICT');
  const inserted = await db.from('knowledge_documents').insert({
    organization_id: organizationId, collection_id: collectionId, file_id: file.id, added_by: userId, title: input.title || file.filename,
  }).select('id').single();
  if (inserted.error?.code === '42501') {
    // Readable but not writable => 403; not even readable => indistinguishable from missing.
    const visible = check(await db.from('knowledge_collections').select('id').eq('id', collectionId).eq('organization_id', organizationId).maybeSingle());
    throw new WorkspaceError(visible ? 403 : 404, visible ? 'FORBIDDEN' : 'NOT_FOUND');
  }
  if (inserted.error?.code === '23505') throw new WorkspaceError(409, 'ALREADY_EXISTS');
  const created = check(inserted) as Record<string, unknown> | null;
  return indexDocument(db, store, organizationId, userId, str(created?.id), file.id);
}

export async function reindexDocument(db: WorkspaceDb, store: BlobStore, organizationId: string, userId: string, collectionId: string, documentId: string): Promise<LibraryDocument> {
  const doc = check(await db.from('knowledge_documents').select(DOCUMENT_COLS).eq('id', documentId).eq('collection_id', collectionId).eq('organization_id', organizationId).maybeSingle());
  if (!doc) throw new WorkspaceError(404, 'NOT_FOUND');
  return indexDocument(db, store, organizationId, userId, documentId, toDocument(doc).fileId);
}

export async function removeDocument(db: WorkspaceDb, organizationId: string, collectionId: string, documentId: string): Promise<void> {
  const deleted = rows(await db.from('knowledge_documents').delete().eq('id', documentId).eq('collection_id', collectionId).eq('organization_id', organizationId).select('id'));
  if (deleted.length === 0) throw new WorkspaceError(404, 'NOT_FOUND');
}

export function parseCollectionIds(v: string | null): string[] | null {
  if (v === null || v === '') return null;
  const ids = v.split(',');
  if (ids.length > 50 || !ids.every(isUuid)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return [...new Set(ids.map((i) => i.toLowerCase()))];
}

export async function searchLibrary(db: WorkspaceDb, organizationId: string, q: string, collectionIds: string[] | null, limit: number): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) throw new WorkspaceError(400, 'QUERY_REQUIRED');
  if (Array.from(query).length > 200) throw new WorkspaceError(400, 'QUERY_TOO_LONG');
  return rows(await db.rpc('search_knowledge', { p_organization_id: organizationId, p_query: query, p_collection_ids: collectionIds, p_limit: limit }))
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        chunkId: str(r.chunk_id), documentId: str(r.document_id), collectionId: str(r.collection_id), fileId: str(r.file_id),
        title: str(r.title), ordinal: num(r.ordinal), snippet: str(r.snippet), rank: typeof r.rank === 'number' ? r.rank : 0,
      };
    });
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
