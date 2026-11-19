/**
 * Conversation management over chat_threads + chat_folders (20261119100001).
 * Ownership is enforced by RLS (owner-only, active member); the explicit
 * organization/owner filters only narrow the query and make a cross-tenant id
 * indistinguishable from a missing one (404).
 */
import type { Conversation, ConversationList, ConversationPatch, ConversationQuery, Folder } from './contracts';
import { check, oneOf, optStr, rows, str, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';
import { cleanName, isUuid } from './http';

const THREAD_COLS = 'id,title,model_key,folder_id,archived_at,created_at,updated_at';
const FOLDER_COLS = 'id,name,created_at,updated_at';
export const TITLE_MAX = 200;
export const FOLDER_NAME_MAX = 80;
export const MAX_FOLDERS = 200;

export function toConversation(row: unknown): Conversation {
  const r = row as Record<string, unknown>;
  return {
    id: str(r.id), title: str(r.title), modelKey: str(r.model_key), folderId: optStr(r.folder_id),
    archivedAt: optStr(r.archived_at), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    matchSource: r.match_source == null ? null : oneOf(r.match_source, ['title', 'message'] as const),
    snippet: optStr(r.snippet),
  };
}
function toFolder(row: unknown): Folder {
  const r = row as Record<string, unknown>;
  return { id: str(r.id), name: str(r.name), createdAt: str(r.created_at), updatedAt: str(r.updated_at) };
}

export async function searchConversations(db: WorkspaceDb, organizationId: string, q: ConversationQuery): Promise<ConversationList> {
  const limit = q.limit ?? 50;
  const query = q.q?.trim() ?? '';
  if (Array.from(query).length > 200) throw new WorkspaceError(400, 'QUERY_TOO_LONG');
  if (q.folderId !== undefined && !isUuid(q.folderId)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  const threads = rows(await db.rpc('search_chat_threads', {
    p_organization_id: organizationId, p_query: query || null, p_archived: q.archived ?? false,
    p_folder_id: q.folderId ?? null, p_unfiled: q.unfiled ?? false, p_limit: limit, p_before: q.before ?? null,
  })).map(toConversation);
  return { threads, nextCursor: threads.length === limit ? threads[threads.length - 1].updatedAt : null };
}

export function parsePatch(body: Record<string, unknown>): ConversationPatch {
  const patch: { title?: string; archived?: boolean; folderId?: string | null } = {};
  if ('title' in body) patch.title = cleanName(body.title, TITLE_MAX);
  if ('archived' in body) {
    if (typeof body.archived !== 'boolean') throw new WorkspaceError(400, 'INVALID_REQUEST');
    patch.archived = body.archived;
  }
  if ('folderId' in body) {
    if (body.folderId !== null && !isUuid(body.folderId)) throw new WorkspaceError(400, 'INVALID_REQUEST');
    patch.folderId = body.folderId as string | null;
  }
  if (Object.keys(patch).length === 0) throw new WorkspaceError(400, 'INVALID_REQUEST');
  return patch;
}

export async function updateConversation(db: WorkspaceDb, organizationId: string, userId: string, threadId: string, patch: ConversationPatch): Promise<Conversation> {
  const values: Record<string, unknown> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.archived !== undefined) values.archived_at = patch.archived ? new Date().toISOString() : null;
  if (patch.folderId !== undefined) values.folder_id = patch.folderId;
  const data = check(await db.from('chat_threads').update(values)
    .eq('id', threadId).eq('organization_id', organizationId).eq('owner_user_id', userId)
    .select(THREAD_COLS).maybeSingle());
  if (!data) throw new WorkspaceError(404, 'NOT_FOUND');
  return toConversation(data);
}

/** Hard delete. Messages, attachments and collection links cascade; the audit row survives. */
export async function deleteConversation(db: WorkspaceDb, organizationId: string, userId: string, threadId: string): Promise<void> {
  const deleted = rows(await db.from('chat_threads').delete()
    .eq('id', threadId).eq('organization_id', organizationId).eq('owner_user_id', userId).select('id'));
  if (deleted.length === 0) throw new WorkspaceError(404, 'NOT_FOUND');
}

/** Owner-only read used by sub-resources (attachments, collections) to 404 foreign threads early. */
export async function assertOwnThread(db: WorkspaceDb, organizationId: string, userId: string, threadId: string): Promise<void> {
  const data = check(await db.from('chat_threads').select('id')
    .eq('id', threadId).eq('organization_id', organizationId).eq('owner_user_id', userId).maybeSingle());
  if (!data) throw new WorkspaceError(404, 'NOT_FOUND');
}

export async function listFolders(db: WorkspaceDb, organizationId: string, userId: string): Promise<Folder[]> {
  return rows(await db.from('chat_folders').select(FOLDER_COLS)
    .eq('organization_id', organizationId).eq('owner_user_id', userId)
    .order('name', { ascending: true }).limit(MAX_FOLDERS)).map(toFolder);
}

export async function createFolder(db: WorkspaceDb, organizationId: string, userId: string, name: string): Promise<Folder> {
  const existing = await listFolders(db, organizationId, userId);
  if (existing.length >= MAX_FOLDERS) throw new WorkspaceError(429, 'LIMIT_EXCEEDED');
  return toFolder(check(await db.from('chat_folders').insert({ organization_id: organizationId, owner_user_id: userId, name })
    .select(FOLDER_COLS).single()));
}

export async function renameFolder(db: WorkspaceDb, organizationId: string, userId: string, folderId: string, name: string): Promise<Folder> {
  const data = check(await db.from('chat_folders').update({ name, updated_at: new Date().toISOString() })
    .eq('id', folderId).eq('organization_id', organizationId).eq('owner_user_id', userId).select(FOLDER_COLS).maybeSingle());
  if (!data) throw new WorkspaceError(404, 'NOT_FOUND');
  return toFolder(data);
}

/** Deleting a folder un-files its conversations (FK ON DELETE SET NULL); it never deletes them. */
export async function deleteFolder(db: WorkspaceDb, organizationId: string, userId: string, folderId: string): Promise<void> {
  const deleted = rows(await db.from('chat_folders').delete()
    .eq('id', folderId).eq('organization_id', organizationId).eq('owner_user_id', userId).select('id'));
  if (deleted.length === 0) throw new WorkspaceError(404, 'NOT_FOUND');
}
