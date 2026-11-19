/**
 * Workspace files: upload validation and metadata access (20261119100003).
 *
 * Upload validation is an ALLOWLIST. A file is accepted only when all three
 * agree: the extension, the declared Content-Type, and the content itself
 * (magic bytes for binary formats, strict UTF-8 without NUL for text). Active
 * content types (HTML, SVG, XML, JavaScript, executables) are not on the list,
 * and downloads are always served as attachments with nosniff and a sandbox
 * CSP, so even a mislabelled file cannot execute in the application origin.
 */
import { createHash } from 'node:crypto';
import type { FileVisibility, WorkspaceFile } from './contracts';
import { check, num, oneOf, optStr, rows, str, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';

type Sniff = (b: Uint8Array) => boolean;
const startsWith = (sig: number[], offset = 0): Sniff => (b) => b.length >= offset + sig.length && sig.every((x, i) => b[offset + i] === x);
const ZIP = startsWith([0x50, 0x4b, 0x03, 0x04]);
const isUtf8Text: Sniff = (b) => {
  if (b.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
};

interface FileType { readonly mediaType: string; readonly aliases: readonly string[]; readonly sniff: Sniff; readonly text: boolean }
const T = (mediaType: string, sniff: Sniff, aliases: string[] = [], text = false): FileType => ({ mediaType, aliases, sniff, text });

/** extension -> accepted type. The stored media type is always the canonical one. */
export const FILE_TYPES: Readonly<Record<string, FileType>> = {
  txt: T('text/plain', isUtf8Text, [], true),
  log: T('text/plain', isUtf8Text, [], true),
  md: T('text/markdown', isUtf8Text, ['text/x-markdown', 'text/plain'], true),
  markdown: T('text/markdown', isUtf8Text, ['text/x-markdown', 'text/plain'], true),
  csv: T('text/csv', isUtf8Text, ['application/vnd.ms-excel', 'text/plain'], true),
  json: T('application/json', isUtf8Text, ['text/json'], true),
  pdf: T('application/pdf', startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])),
  docx: T('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP),
  xlsx: T('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP),
  pptx: T('application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP),
  png: T('image/png', startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: T('image/jpeg', startsWith([0xff, 0xd8, 0xff])),
  jpeg: T('image/jpeg', startsWith([0xff, 0xd8, 0xff])),
  gif: T('image/gif', (b) => startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])(b) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])(b)),
  webp: T('image/webp', (b) => startsWith([0x52, 0x49, 0x46, 0x46])(b) && startsWith([0x57, 0x45, 0x42, 0x50], 8)(b)),
};
export const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set(Object.values(FILE_TYPES).filter((t) => t.text).map((t) => t.mediaType));

/**
 * Normalise a client-supplied filename to a safe display name: last path
 * segment only, NFC, no control or bidi-override characters, <= 255 chars with
 * the extension preserved. Throws INVALID_FILENAME when nothing usable remains.
 */
export function sanitizeFilename(input: unknown): string {
  if (typeof input !== 'string' || input.length > 1024) throw new WorkspaceError(400, 'INVALID_FILENAME');
  let name = input.normalize('NFC').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  if (!name || name === '.' || name === '..') throw new WorkspaceError(400, 'INVALID_FILENAME');
  const chars = Array.from(name);
  if (chars.length > 255) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? Array.from(name.slice(dot)).slice(0, 16).join('') : '';
    name = Array.from(name.slice(0, dot > 0 ? dot : undefined)).slice(0, 255 - Array.from(ext).length).join('') + ext;
  }
  return name;
}
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** Returns the canonical media type, or throws UNSUPPORTED_MEDIA_TYPE / MEDIA_TYPE_MISMATCH. */
export function validateUpload(filename: string, declaredContentType: string | null, bytes: Uint8Array): string {
  const type = FILE_TYPES[extensionOf(filename)];
  if (!type) throw new WorkspaceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const declared = (declaredContentType ?? '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== type.mediaType && !type.aliases.includes(declared)) {
    throw new WorkspaceError(415, 'MEDIA_TYPE_MISMATCH');
  }
  if (bytes.length === 0 ? !type.text : !type.sniff(bytes)) throw new WorkspaceError(415, 'MEDIA_TYPE_MISMATCH');
  return type.mediaType;
}

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Read a request body with a hard byte cap, aborting the stream as soon as it is exceeded. */
export async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new WorkspaceError(413, 'PAYLOAD_TOO_LARGE');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new WorkspaceError(413, 'PAYLOAD_TOO_LARGE');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

export const FILE_COLS = 'id,owner_user_id,filename,media_type,size_bytes,sha256,visibility,status,created_at,updated_at';
export function toFile(row: unknown, userId: string): WorkspaceFile {
  const r = row as Record<string, unknown>;
  return {
    id: str(r.id), filename: str(r.filename), mediaType: str(r.media_type), sizeBytes: num(r.size_bytes), sha256: optStr(r.sha256),
    visibility: oneOf(r.visibility, ['private', 'organization'] as const), status: oneOf(r.status, ['uploading', 'ready', 'failed'] as const),
    ownedByMe: str(r.owner_user_id) === userId, createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

export function parseVisibility(v: string | null | undefined): FileVisibility {
  if (v === null || v === undefined || v === 'private') return 'private';
  if (v === 'organization') return 'organization';
  throw new WorkspaceError(400, 'INVALID_REQUEST');
}

export async function insertUploading(db: WorkspaceDb, organizationId: string, userId: string, f: { filename: string; mediaType: string; sizeBytes: number; visibility: FileVisibility }): Promise<string> {
  const data = check(await db.from('workspace_files').insert({
    organization_id: organizationId, owner_user_id: userId, filename: f.filename, media_type: f.mediaType,
    size_bytes: f.sizeBytes, visibility: f.visibility,
  }).select('id').single()) as Record<string, unknown> | null;
  return str(data?.id);
}

export async function markReady(db: WorkspaceDb, organizationId: string, fileId: string, sha256: string, userId: string): Promise<WorkspaceFile> {
  const data = check(await db.from('workspace_files').update({ status: 'ready', sha256 })
    .eq('id', fileId).eq('organization_id', organizationId).select(FILE_COLS).single());
  return toFile(data, userId);
}

export async function removeRow(db: WorkspaceDb, organizationId: string, fileId: string): Promise<boolean> {
  return rows(await db.from('workspace_files').delete().eq('id', fileId).eq('organization_id', organizationId).select('id')).length > 0;
}

/** RLS decides: own files, plus ready organization-visible files. */
export async function getFile(db: WorkspaceDb, organizationId: string, userId: string, fileId: string): Promise<WorkspaceFile> {
  const data = check(await db.from('workspace_files').select(FILE_COLS).eq('id', fileId).eq('organization_id', organizationId).maybeSingle());
  if (!data) throw new WorkspaceError(404, 'NOT_FOUND');
  return toFile(data, userId);
}

export async function listFiles(db: WorkspaceDb, organizationId: string, userId: string, q: { scope: 'mine' | 'organization'; limit: number; before: string | null }): Promise<{ files: WorkspaceFile[]; nextCursor: string | null }> {
  let query = db.from('workspace_files').select(FILE_COLS).eq('organization_id', organizationId);
  query = q.scope === 'mine' ? query.eq('owner_user_id', userId) : query.eq('visibility', 'organization').eq('status', 'ready');
  if (q.before) query = query.lt('created_at', q.before);
  const files = rows(await query.order('created_at', { ascending: false }).limit(q.limit)).map((r) => toFile(r, userId));
  return { files, nextCursor: files.length === q.limit ? files[files.length - 1].createdAt : null };
}

/** Rename keeps the extension so the stored media type stays truthful. */
export async function renameFile(db: WorkspaceDb, organizationId: string, userId: string, fileId: string, filename: string): Promise<WorkspaceFile> {
  const current = await getFile(db, organizationId, userId, fileId);
  if (!current.ownedByMe) throw new WorkspaceError(403, 'FORBIDDEN');
  if (extensionOf(filename) !== extensionOf(current.filename)) throw new WorkspaceError(400, 'INVALID_FILENAME');
  const data = check(await db.from('workspace_files').update({ filename })
    .eq('id', fileId).eq('organization_id', organizationId).eq('owner_user_id', userId).select(FILE_COLS).maybeSingle());
  if (!data) throw new WorkspaceError(404, 'NOT_FOUND');
  return toFile(data, userId);
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(filename: string): string {
  const ascii = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export const DOWNLOAD_SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
} as const;
