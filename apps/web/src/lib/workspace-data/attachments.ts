/**
 * Conversation attachments (chat_thread_attachments, 20261119100003).
 * Policies: the thread must be the caller's (not archived for new links) and
 * the file must be a READY file the caller can read; composite FKs pin both to
 * the same organization.
 */
import type { Attachment } from './contracts';
import { check, rows, str, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';
import { FILE_COLS, toFile } from './files';

export async function listAttachments(db: WorkspaceDb, organizationId: string, userId: string, threadId: string): Promise<Attachment[]> {
  const links = rows(await db.from('chat_thread_attachments').select('file_id,created_at')
    .eq('thread_id', threadId).eq('organization_id', organizationId).order('created_at', { ascending: true }).limit(100));
  if (links.length === 0) return [];
  const when = new Map(links.map((l) => { const r = l as Record<string, unknown>; return [str(r.file_id), str(r.created_at)] as const; }));
  // Files the caller can no longer read (made private, deleted) drop out here.
  const files = rows(await db.from('workspace_files').select(FILE_COLS).eq('organization_id', organizationId).in('id', [...when.keys()]).limit(100));
  return files.map((f) => toFile(f, userId)).map((file) => ({ file, attachedAt: when.get(file.id)! }))
    .sort((a, b) => a.attachedAt.localeCompare(b.attachedAt));
}

export async function attachFile(db: WorkspaceDb, organizationId: string, userId: string, threadId: string, fileId: string): Promise<Attachment> {
  const fileRow = check(await db.from('workspace_files').select(FILE_COLS).eq('id', fileId).eq('organization_id', organizationId).maybeSingle());
  if (!fileRow) throw new WorkspaceError(404, 'NOT_FOUND');
  const file = toFile(fileRow, userId);
  if (file.status !== 'ready') throw new WorkspaceError(409, 'CONFLICT');
  const r = await db.from('chat_thread_attachments').insert({ thread_id: threadId, file_id: fileId, organization_id: organizationId, attached_by: userId })
    .select('created_at').single();
  if (r.error?.code === '23505') {
    const existing = check(await db.from('chat_thread_attachments').select('created_at').eq('thread_id', threadId).eq('file_id', fileId).single()) as Record<string, unknown>;
    return { file, attachedAt: str(existing.created_at) };
  }
  // RLS rejects archived threads; report that as a conflict rather than a permission problem.
  if (r.error?.code === '42501') throw new WorkspaceError(409, 'CONFLICT');
  const data = check(r) as Record<string, unknown>;
  return { file, attachedAt: str(data.created_at) };
}

export async function detachFile(db: WorkspaceDb, organizationId: string, threadId: string, fileId: string): Promise<void> {
  const deleted = rows(await db.from('chat_thread_attachments').delete().eq('thread_id', threadId).eq('file_id', fileId).eq('organization_id', organizationId).select('file_id'));
  if (deleted.length === 0) throw new WorkspaceError(404, 'NOT_FOUND');
}
