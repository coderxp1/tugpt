/**
 * Text extraction and chunking for Library indexing.
 *
 *   text/plain, text/markdown, text/csv, application/json   strict UTF-8
 *   DOCX   word/document.xml (visible text; field codes and tracked deletions dropped)
 *   XLSX   every worksheet in workbook order, shared + inline strings, one
 *          paragraph per non-empty row ("Sheet!row: a | b | c")
 *   PPTX   every slide in presentation order: visible text (shapes, tables,
 *          groups) one paragraph per <a:p>, then the speaker notes
 *          ("Slide 3: ..." / "Slide 3 notes: ..."); fields (slide numbers) dropped
 *   PDF    through an injected PdfExtractor (see ./pdf, worker-only), so the
 *          web bundle never loads a PDF engine
 *
 * Everything is bounded: per-entry and total inflation caps, cell and sheet
 * caps, output character cap. Nothing here touches the network.
 */
import { MAX_ENTRY_BYTES, readEntry, zipEntries, type ZipEntry } from './zip';

export const MAX_TEXT_CHARS = 2_000_000;
export const MAX_XML_BYTES = MAX_ENTRY_BYTES;
export const MAX_TOTAL_INFLATE_BYTES = 100 * 1024 * 1024;
export const MAX_XLSX_SHEETS = 100;
export const MAX_XLSX_CELLS = 500_000;
export const MAX_PPTX_SLIDES = 1000;
export const CHUNK_TARGET = 1500;
export const CHUNK_OVERLAP = 150;
export const MAX_CHUNKS = 2000;

export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const PDF_MEDIA_TYPE = 'application/pdf';
export const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
export const INDEXABLE_MEDIA_TYPES: ReadonlySet<string> = new Set([...TEXT_MEDIA_TYPES, DOCX_MEDIA_TYPE, XLSX_MEDIA_TYPE, PPTX_MEDIA_TYPE, PDF_MEDIA_TYPE]);

export type ExtractionCode =
  | 'PDF_EXTRACTION_UNAVAILABLE' | 'PDF_ENCRYPTED' | 'PDF_NO_TEXT_LAYER' | 'UNSUPPORTED_FOR_INDEXING'
  | 'DOCUMENT_TOO_LARGE' | 'EXTRACTION_FAILED' | 'EMPTY_DOCUMENT';
export type Extraction =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unsupported' | 'failed'; readonly code: ExtractionCode };

/** Thrown by a PdfExtractor for outcomes that map to a specific code. */
export class ExtractionError extends Error {
  constructor(readonly code: ExtractionCode) { super(code); this.name = 'ExtractionError'; }
}
export type PdfExtractor = (bytes: Uint8Array) => Promise<string>;

class TooLarge extends Error {}

function finish(raw: string, emptyCode: ExtractionCode = 'EMPTY_DOCUMENT'): Extraction {
  // eslint-disable-next-line no-control-regex -- stripping C0 controls is the point
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (text.length > MAX_TEXT_CHARS) return { kind: 'failed', code: 'DOCUMENT_TOO_LARGE' };
  if (!text.trim()) return { kind: 'failed', code: emptyCode };
  return { kind: 'text', text };
}

/** Synchronous formats only; PDF reports PDF_EXTRACTION_UNAVAILABLE (use extractDocument with a PdfExtractor). */
export function extractText(bytes: Uint8Array, mediaType: string): Extraction {
  try {
    if (TEXT_MEDIA_TYPES.has(mediaType)) return finish(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (mediaType === DOCX_MEDIA_TYPE) {
      const zip = openZip(bytes);
      return finish(docxXmlToText(zip.text('word/document.xml')));
    }
    if (mediaType === XLSX_MEDIA_TYPE) return finish(xlsxToText(openZip(bytes)));
    if (mediaType === PPTX_MEDIA_TYPE) return finish(pptxToText(openZip(bytes)));
    if (mediaType === PDF_MEDIA_TYPE) return { kind: 'unsupported', code: 'PDF_EXTRACTION_UNAVAILABLE' };
    return { kind: 'unsupported', code: 'UNSUPPORTED_FOR_INDEXING' };
  } catch (e) {
    return { kind: 'failed', code: e instanceof TooLarge ? 'DOCUMENT_TOO_LARGE' : 'EXTRACTION_FAILED' };
  }
}

/** All supported formats. Never throws for content problems. */
export async function extractDocument(bytes: Uint8Array, mediaType: string, opts: { readonly pdf?: PdfExtractor } = {}): Promise<Extraction> {
  if (mediaType !== PDF_MEDIA_TYPE) return extractText(bytes, mediaType);
  if (!opts.pdf) return { kind: 'unsupported', code: 'PDF_EXTRACTION_UNAVAILABLE' };
  try {
    return finish(await opts.pdf(bytes), 'PDF_NO_TEXT_LAYER');
  } catch (e) {
    if (e instanceof ExtractionError) return { kind: e.code === 'PDF_ENCRYPTED' ? 'unsupported' : 'failed', code: e.code };
    return { kind: 'failed', code: 'EXTRACTION_FAILED' };
  }
}

// ---------------------------------------------------------------- OOXML helpers
interface OpenZip { has(name: string): boolean; text(name: string): string; names(): string[] }
function openZip(bytes: Uint8Array): OpenZip {
  const entries = zipEntries(bytes);
  if (!entries) throw new Error('not a zip');
  const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name, e]));
  let budget = MAX_TOTAL_INFLATE_BYTES;
  return {
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
    text(name) {
      const e = byName.get(name);
      if (!e) throw new Error('missing entry');
      const data = readEntry(bytes, e, Math.min(MAX_XML_BYTES, budget));
      if (data === 'too_large') throw new TooLarge();
      if (!data) throw new Error('unreadable entry');
      budget -= data.length;
      return new TextDecoder('utf-8').decode(data);
    },
  };
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

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXmlEntities(m[3] ?? m[4] ?? '');
  return out;
}
/** Concatenated <t> runs, excluding phonetic (<rPh>) guides. */
function runText(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += m[1];
  return decodeXmlEntities(s);
}

/** Worksheet XML paths in workbook order (workbook.xml + its rels), falling back to file order. */
function sheetOrder(zip: OpenZip): { name: string; path: string }[] {
  const fallback = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))
    .map((p, i) => ({ name: `Sheet${i + 1}`, path: p }));
  if (!zip.has('xl/workbook.xml') || !zip.has('xl/_rels/workbook.xml.rels')) return fallback;
  const rels = new Map<string, string>();
  for (const m of zip.text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.Id || !a.Target || !/\/worksheet$/.test(a.Type ?? '')) continue;
    const target = a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`;
    if (!target.split('/').includes('..')) rels.set(a.Id, target);
  }
  const out: { name: string; path: string }[] = [];
  for (const m of zip.text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const rid = a['r:id'] ?? Object.entries(a).find(([k]) => k.endsWith(':id'))?.[1];
    const path = rid ? rels.get(rid) : undefined;
    if (path && zip.has(path)) out.push({ name: (a.name ?? `Sheet${out.length + 1}`).replace(/[\r\n\t]/g, ' ').slice(0, 64), path });
  }
  return out.length > 0 ? out : fallback;
}

export function xlsxToText(zip: OpenZip): string {
  const shared: string[] = [];
  if (zip.has('xl/sharedStrings.xml')) {
    for (const m of zip.text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? runText(m[1]) : '');
  }
  const sheets = sheetOrder(zip);
  if (sheets.length === 0) throw new Error('no worksheets');
  if (sheets.length > MAX_XLSX_SHEETS) throw new TooLarge();
  let cells = 0;
  const paragraphs: string[] = [];
  for (const sheet of sheets) {
    const xml = zip.text(sheet.path);
    paragraphs.push(`Sheet: ${sheet.name}`);
    let rowIndex = 0;
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      rowIndex += 1;
      const rowNo = attrs(`<row ${row[1]}>`).r ?? String(rowIndex);
      const values: string[] = [];
      for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cells > MAX_XLSX_CELLS) throw new TooLarge();
        const a = attrs(`<c ${c[1]}>`);
        const inner = c[2] ?? '';
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        let value = '';
        switch (a.t) {
          case 's': value = v !== undefined ? shared[Number(v)] ?? '' : ''; break;
          case 'inlineStr': value = runText(inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? ''); break;
          case 'b': value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : ''; break;
          case 'e': value = ''; break; // error values (#DIV/0! etc.) carry no content
          default: value = v !== undefined ? decodeXmlEntities(v) : '';
        }
        value = value.replace(/\s+/g, ' ').trim();
        if (value) values.push(value);
      }
      if (values.length > 0) paragraphs.push(`${sheet.name}!${rowNo}: ${values.join(' | ')}`);
    }
  }
  return paragraphs.join('\n\n');
}

// ---------------------------------------------------------------- PPTX
/**
 * Resolves a relationship target against the part that owns the .rels file.
 * Package-absolute targets start with '/'. Returns null for external targets
 * and for anything that would leave the package root.
 */
export function resolvePartTarget(sourcePart: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const base = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  const out = [...base];
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length === 0) return null; out.pop(); } else out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}
function relsPath(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}
/** Internal relationships of a part: id -> { type, path }. */
function partRels(zip: OpenZip, part: string): Map<string, { type: string; path: string }> {
  const out = new Map<string, { type: string; path: string }>();
  const rp = relsPath(part);
  if (!zip.has(rp)) return out;
  for (const m of zip.text(rp).matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.Id || !a.Target || a.TargetMode === 'External') continue;
    const path = resolvePartTarget(part, a.Target);
    if (path) out.set(a.Id, { type: a.Type ?? '', path });
  }
  return out;
}
/** One string per non-empty <a:p>: concatenated <a:t> runs, <a:br/> as a line break, <a:fld> dropped when asked. */
export function drawingMlParagraphs(xml: string, opts: { dropFields?: boolean } = {}): string[] {
  const src = opts.dropFields ? xml.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, '') : xml;
  const out: string[] = [];
  for (const p of src.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)) {
    let t = '';
    for (const r of (p[1] ?? '').matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) t += r[1] !== undefined ? decodeXmlEntities(r[1]) : '\n';
    t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (t) out.push(t);
  }
  return out;
}
/** Slide parts in presentation order (presentation.xml sldIdLst + its rels), falling back to file-name order. */
function slideOrder(zip: OpenZip): string[] {
  const num = (n: string) => Number(n.match(/(\d+)\.xml$/)![1]);
  const fallback = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const pres = 'ppt/presentation.xml';
  if (!zip.has(pres)) return fallback;
  const rels = partRels(zip, pres);
  const out: string[] = [];
  const list = zip.text(pres).match(/<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? '';
  for (const m of list.matchAll(/<p:sldId\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const rid = a['r:id'] ?? Object.entries(a).find(([k]) => k.endsWith(':id') && k !== 'id')?.[1];
    const rel = rid ? rels.get(rid) : undefined;
    if (rel && /\/slide$/.test(rel.type) && zip.has(rel.path) && !out.includes(rel.path)) out.push(rel.path);
  }
  return out.length > 0 ? out : fallback;
}
export function pptxToText(zip: OpenZip): string {
  const slides = slideOrder(zip);
  if (slides.length === 0) throw new Error('no slides');
  if (slides.length > MAX_PPTX_SLIDES) throw new TooLarge();
  const paragraphs: string[] = [];
  slides.forEach((slide, i) => {
    const n = i + 1;
    const body = drawingMlParagraphs(zip.text(slide));
    if (body.length > 0) paragraphs.push(`Slide ${n}: ${body[0]}`, ...body.slice(1));
    const notes = [...partRels(zip, slide).values()].find((r) => /\/notesSlide$/.test(r.type) && zip.has(r.path));
    if (notes) {
      const lines = drawingMlParagraphs(zip.text(notes.path), { dropFields: true });
      if (lines.length > 0) paragraphs.push(`Slide ${n} notes: ${lines[0]}`, ...lines.slice(1));
    }
  });
  return paragraphs.join('\n\n');
}

// ---------------------------------------------------------------- chunking
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
