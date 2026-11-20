/** Test-only builders for real ZIP/XLSX/PDF bytes. Excluded from dist. */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function makeZip(entries: Record<string, string | Uint8Array>, opts: { store?: boolean } = {}): Uint8Array {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const data = opts.store ? raw : deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8'); const crc = crc32(raw); const method = opts.store ? 0 : 8;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** sheets: [name, rowsXml][] in workbook order; files are numbered in REVERSE to prove order comes from workbook.xml. */
export function makeXlsx(sheets: [string, string][], sharedStrings: string[] = [], extra: Record<string, string> = {}): Uint8Array {
  const n = sheets.length;
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n - i}.xml"/>`).join('')}</Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS} count="${sharedStrings.length}">${sharedStrings.map((s) => `<si>${s}</si>`).join('')}</sst>`,
    ...extra,
  };
  sheets.forEach(([, rows], i) => { files[`xl/worksheets/sheet${n - i}.xml`] = `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`; });
  return makeZip(files);
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = (body: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
/** DrawingML paragraphs: each string becomes one <a:p> with one run per word group. */
export const aParas = (ps: string[]) => ps.map((t) => `<a:p><a:pPr lvl="0"/>${t.split(' | ').map((r) => `<a:r><a:rPr lang="en-US"/><a:t>${r}</a:t></a:r>`).join('')}</a:p>`).join('');
/**
 * Minimal PPTX. Slides are listed in presentation order but stored under
 * reversed file names (slideN.xml is the first slide), so tests prove the
 * extractor follows presentation.xml rather than file names. `body` and
 * `notes` are raw inner XML (use aParas).
 */
export function makePptx(slides: { body: string; notes?: string }[], extra: Record<string, string> = {}): Uint8Array {
  const n = slides.length;
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${A} xmlns:r="${REL}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': RELS(`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, i) =>
      `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${n - i}.xml"/>`).join('')}`),
    ...extra,
  };
  slides.forEach((s, i) => {
    const f = n - i;
    files[`ppt/slides/slide${f}.xml`] = `<?xml version="1.0"?><p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${s.body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    if (s.notes !== undefined) {
      files[`ppt/slides/_rels/slide${f}.xml.rels`] = RELS(`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${f}.xml"/>`);
      files[`ppt/notesSlides/notesSlide${f}.xml`] = `<?xml version="1.0"?><p:notes ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:fld id="{1}" type="slidenum"><a:t>${f}</a:t></a:fld></a:p></p:txBody></p:sp><p:sp><p:txBody>${s.notes}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  return makeZip(files);
}

/** A real, minimal PDF 1.4 with one Helvetica text line per array entry, one page per inner array. */
export function makePdf(pages: string[][]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: string[] = [];
  const fontId = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  pages.forEach((lines, i) => {
    const pageId = 3 + i * 2; const contentId = pageId + 1;
    const ops = lines.length === 0 ? '0 0 m 10 10 l S' : `BT /F1 12 Tf 72 720 Td ${lines.map((l, j) => `${j ? '0 -16 Td ' : ''}(${esc(l)}) Tj`).join(' ')} ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
