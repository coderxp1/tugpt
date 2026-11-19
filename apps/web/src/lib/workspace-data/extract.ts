/**
 * Text extraction and chunking for Library indexing. Runs in-process on bytes
 * the caller is already allowed to read; nothing here touches the network.
 *
 * Supported now: text/plain, text/markdown, text/csv, application/json, DOCX
 * (OOXML word/document.xml through Node's zlib; no third-party parser).
 * Not yet: PDF (no PDF parser is available offline in this build; documents
 * are marked `unsupported` with PDF_EXTRACTION_UNAVAILABLE and can be
 * re-indexed once a worker-side extractor exists), images (OCR), XLSX/PPTX.
 *
 * Zip-bomb and size limits are enforced before and during inflation.
 */
import { inflateRawSync } from 'node:zlib';
import { TEXT_MEDIA_TYPES } from './files';

export const MAX_TEXT_CHARS = 2_000_000;
export const MAX_XML_BYTES = 20 * 1024 * 1024;
export const CHUNK_TARGET = 1500;
export const CHUNK_OVERLAP = 150;
export const MAX_CHUNKS = 2000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ExtractionCode =
  | 'PDF_EXTRACTION_UNAVAILABLE' | 'UNSUPPORTED_FOR_INDEXING' | 'DOCUMENT_TOO_LARGE' | 'EXTRACTION_FAILED' | 'EMPTY_DOCUMENT';
export type Extraction = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'unsupported' | 'failed'; readonly code: ExtractionCode };

export function extractText(bytes: Uint8Array, mediaType: string): Extraction {
  try {
    let text: string;
    if (TEXT_MEDIA_TYPES.has(mediaType)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    else if (mediaType === DOCX) {
      const xml = readZipEntry(bytes, 'word/document.xml');
      if (xml === 'too_large') return { kind: 'failed', code: 'DOCUMENT_TOO_LARGE' };
      if (!xml) return { kind: 'failed', code: 'EXTRACTION_FAILED' };
      text = docxXmlToText(new TextDecoder('utf-8').decode(xml));
    } else if (mediaType === 'application/pdf') return { kind: 'unsupported', code: 'PDF_EXTRACTION_UNAVAILABLE' };
    else return { kind: 'unsupported', code: 'UNSUPPORTED_FOR_INDEXING' };
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (text.length > MAX_TEXT_CHARS) return { kind: 'failed', code: 'DOCUMENT_TOO_LARGE' };
    if (!text.trim()) return { kind: 'failed', code: 'EMPTY_DOCUMENT' };
    return { kind: 'text', text };
  } catch {
    return { kind: 'failed', code: 'EXTRACTION_FAILED' };
  }
}

/** Minimal ZIP reader: one named entry, stored or deflated, no ZIP64, bounded output. */
export function readZipEntry(zip: Uint8Array, name: string): Uint8Array | null | 'too_large' {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) { if (u32(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return null;
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const want = new TextEncoder().encode(name);
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || u32(p) !== 0x02014b50) return null;
    const method = u16(p + 10); const csize = u32(p + 20); const usize = u32(p + 24);
    const nlen = u16(p + 28); const elen = u16(p + 30); const clen = u16(p + 32); const local = u32(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nlen);
    if (entry.length === want.length && entry.every((b, i) => b === want[i])) {
      if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) return null; // ZIP64 not supported
      if (usize > MAX_XML_BYTES) return 'too_large';
      if (local + 30 > zip.length || u32(local) !== 0x04034b50) return null;
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      const data = zip.subarray(start, start + csize);
      if (data.length !== csize) return null;
      if (method === 0) return data;
      if (method !== 8) return null;
      try { return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES })); } catch (e) {
        return (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : null;
      }
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

/** Visible body text only: field codes and tracked deletions are dropped. */
export function docxXmlToText(xml: string): string {
  return decodeXmlEntities(xml
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Paragraph-aware chunks of ~CHUNK_TARGET chars with a short word-aligned overlap. */
export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_TARGET) { pieces.push(p); continue; }
    let rest = p;
    while (rest.length > CHUNK_TARGET) {
      let cut = rest.lastIndexOf(' ', CHUNK_TARGET);
      if (cut < CHUNK_TARGET / 2) cut = CHUNK_TARGET;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + 2 + piece.length > CHUNK_TARGET) {
      chunks.push(current);
      const tail = current.slice(-CHUNK_OVERLAP);
      const space = tail.indexOf(' ');
      current = space >= 0 && space < tail.length - 1 ? `${tail.slice(space + 1)}\n\n${piece}` : piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.slice(0, 8000));
}
