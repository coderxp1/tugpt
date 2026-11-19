/**
 * Business documents in the Workspace (PDF, Word, Excel, PowerPoint, images, larger text files).
 *
 * Mirrors the server's upload rules (docs/workspace/backend-api.md §4) so the UI can refuse early
 * with the real reason; the server checks again (size, allowlist, declared type, sniffed content).
 * Small text files keep travelling inside the message (attachments.ts) because that is what the
 * model can read today. Everything else is uploaded to the Files API and linked to the chat, and the
 * UI says plainly that the assistant does not read those contents yet (contract C-4b).
 */
import { isTextFile, MAX_FILE_BYTES } from './attachments';

/** Server default (TUGPT_FILE_MAX_BYTES). The server may be configured lower; it then answers 413. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOADS = 10;

const TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

/** For <input accept>: what the Files API takes. */
export const UPLOAD_ACCEPT = Object.keys(TYPES).map((e) => `.${e}`).join(',');
/** Library documents: the same allowlist (indexing support is reported per document). */
export const LIBRARY_ACCEPT = UPLOAD_ACCEPT;

export type DocKind = 'pdf' | 'word' | 'sheet' | 'slides' | 'image' | 'text';
export type UploadRefusal = 'type' | 'size' | 'empty' | 'count';

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function isUploadable(name: string): boolean { return extensionOf(name) in TYPES; }

/** Browsers report "" for .md and friends; the server needs a declared type compatible with the extension. */
export function mediaTypeFor(file: { name: string; type: string }): string {
  return TYPES[extensionOf(file.name)] ?? (file.type || 'application/octet-stream');
}

export function kindOf(name: string): DocKind {
  const e = extensionOf(name);
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'word';
  if (e === 'xlsx' || e === 'csv') return 'sheet';
  if (e === 'pptx') return 'slides';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return 'image';
  return 'text';
}

/**
 * What the composer does with a picked file:
 *  - `inline`: a small text file; its text goes into the message (the model reads it).
 *  - `upload`: stored with the chat through the Files API.
 *  - a refusal with the reason.
 */
export type Route = { kind: 'inline' } | { kind: 'upload' } | { kind: 'refuse'; why: UploadRefusal };

export function routeFile(file: { name: string; type: string; size: number }, uploads: number): Route {
  if (file.size === 0) return { kind: 'refuse', why: 'empty' };
  if (isTextFile(file) && file.size <= MAX_FILE_BYTES) return { kind: 'inline' };
  if (!isUploadable(file.name)) return { kind: 'refuse', why: isTextFile(file) ? 'size' : 'type' };
  if (file.size > UPLOAD_MAX_BYTES) return { kind: 'refuse', why: 'size' };
  if (uploads >= MAX_UPLOADS) return { kind: 'refuse', why: 'count' };
  return { kind: 'upload' };
}

export function formatBytes(n: number, locale?: string): string {
  if (n < 1024) return `${n} B`;
  const fmt = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: v < 10 ? 1 : 0 });
  if (n < 1024 * 1024) return `${fmt(n / 1024)} KB`;
  return `${fmt(n / (1024 * 1024))} MB`;
}
