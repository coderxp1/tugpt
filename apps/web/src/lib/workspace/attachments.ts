/**
 * File attachments in the Workspace composer.
 *
 * There is no file-upload API yet (docs/workspace/api-contracts.md, C-4). Until there is, the only
 * honest thing the composer can do with a file is what a person would do by hand: paste a text
 * file's contents into the message. That is what this module does, inside the same 8,000-character
 * limit the messages API enforces, with a visible marker so the conversation can show the file as a
 * chip instead of a wall of text. Binary files (PDF, images, Office) are refused with the reason;
 * they are never "attached" in a way the model cannot actually read.
 */

/** Same limit as MAX_CONTENT in app/api/v1/chat/threads/[threadId]/messages/route.ts. */
export const MESSAGE_LIMIT = 8000;
export const MAX_FILES = 5;
/** Larger files cannot fit the message budget anyway; refuse before reading them. */
export const MAX_FILE_BYTES = 64 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml', 'html', 'htm', 'css',
  'js', 'jsx', 'ts', 'tsx', 'py', 'sql', 'sh', 'ini', 'toml', 'rtf', 'srt', 'vtt',
]);
export const ACCEPT_ATTRIBUTE = [...TEXT_EXTENSIONS].map((e) => `.${e}`).join(',') + ',text/*';

export interface TextAttachment { readonly id: string; readonly name: string; readonly size: number; readonly text: string }
export type AttachmentRefusal = 'type' | 'size' | 'count' | 'empty' | 'unreadable';

function extension(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Text-like by MIME type or by extension (browsers report "" for many code files). */
export function isTextFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json' || file.type === 'application/xml') return true;
  return TEXT_EXTENSIONS.has(extension(file.name));
}

export function refusalFor(file: { name: string; type: string; size: number }, already: number): AttachmentRefusal | null {
  if (already >= MAX_FILES) return 'count';
  if (!isTextFile(file)) return 'type';
  if (file.size > MAX_FILE_BYTES) return 'size';
  if (file.size === 0) return 'empty';
  return null;
}

/** File names end up inside the message; keep them on one line and short. */
export function safeName(name: string): string {
  const flat = name.replace(/[\r\n\t\]\[]+/g, ' ').trim() || 'file';
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

const OPEN = (name: string) => `[Attached file: ${safeName(name)}]`;
const CLOSE = '[End of attached file]';

/** The message text the API receives: what the person typed, then each file between markers. */
export function composeContent(draft: string, files: readonly TextAttachment[]): string {
  const typed = draft.trim();
  if (files.length === 0) return typed;
  const blocks = files.map((f) => `${OPEN(f.name)}\n${f.text.replace(/\r\n/g, '\n').trimEnd()}\n${CLOSE}`);
  return [typed, ...blocks].filter(Boolean).join('\n\n');
}

export function contentLength(draft: string, files: readonly TextAttachment[]): number {
  return composeContent(draft, files).length;
}

export interface SplitMessage { readonly text: string; readonly files: { name: string; chars: number }[] }

const BLOCK = /\[Attached file: ([^\]\n]{1,80})\]\n([\s\S]*?)\n\[End of attached file\]/g;

/** For display: the typed text and the attached files, so a user message shows file chips. */
export function splitAttachments(content: string): SplitMessage {
  const files: { name: string; chars: number }[] = [];
  const text = content.replace(BLOCK, (_m, name: string, body: string) => { files.push({ name, chars: body.length }); return ''; }).trim();
  return { text, files };
}
