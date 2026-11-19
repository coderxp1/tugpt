/**
 * PDF text extraction (worker-only entry: `@tugpt/workspace-core/pdf`).
 *
 * Uses Mozilla pdf.js (pdfjs-dist, legacy Node build) with eval disabled, no
 * font loading, no network/worker fetches, bounded page count, bounded output
 * and a wall-clock deadline checked between pages. pdf.js runs in-process
 * ("fake worker"); a pathological single page can still hold the event loop,
 * which is why extraction runs in the knowledge worker, never in a web request.
 */
import { ExtractionError, MAX_TEXT_CHARS, type PdfExtractor } from './extract';

export interface PdfOptions { readonly maxPages?: number; readonly maxChars?: number; readonly timeoutMs?: number }

interface TextItem { str?: string; hasEOL?: boolean }
interface PdfPage { getTextContent(): Promise<{ items: TextItem[] }>; cleanup(): void }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage> }
interface PdfJs {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}

let loaded: Promise<PdfJs> | undefined;
function pdfjs(): Promise<PdfJs> {
  // pdfjs-dist is ESM-only; module=NodeNext keeps this a native import() in the CommonJS output.
  loaded ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>;
  return loaded;
}

export async function extractPdfText(bytes: Uint8Array, opts: PdfOptions = {}): Promise<string> {
  const maxPages = opts.maxPages ?? 500;
  const maxChars = opts.maxChars ?? MAX_TEXT_CHARS;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes), // pdf.js may transfer/detach the buffer it is given
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    disableAutoFetch: true, disableStream: true, stopAtErrors: false, verbosity: 0,
  });
  let doc: PdfDoc;
  try { doc = await task.promise; } catch (e) {
    await task.destroy().catch(() => {});
    if ((e as { name?: string }).name === 'PasswordException') throw new ExtractionError('PDF_ENCRYPTED');
    throw new ExtractionError('EXTRACTION_FAILED');
  }
  try {
    if (doc.numPages > maxPages) throw new ExtractionError('DOCUMENT_TOO_LARGE');
    const pages: string[] = [];
    let total = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      if (Date.now() > deadline) throw new ExtractionError('DOCUMENT_TOO_LARGE');
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str === 'string') text += item.str;
        if (item.hasEOL) text += '\n';
      }
      page.cleanup();
      text = text.replace(/[ \t]+\n/g, '\n').trim();
      total += text.length;
      if (total > maxChars) throw new ExtractionError('DOCUMENT_TOO_LARGE');
      if (text) pages.push(text);
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy().catch(() => {}); // releases the document and its fake worker
  }
}

export const pdfExtractor: PdfExtractor = (bytes) => extractPdfText(bytes);
