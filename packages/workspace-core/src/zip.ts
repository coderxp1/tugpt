/**
 * Minimal, bounded ZIP reader for OOXML (DOCX/XLSX). Stored or DEFLATE
 * entries only, no ZIP64, no encryption. Every inflation is capped
 * (maxOutputLength), so a zip bomb fails with 'too_large' instead of
 * exhausting memory. No third-party parser and no filesystem access.
 */
import { inflateRawSync } from 'node:zlib';

export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** Central directory listing, or null for anything that is not a well-formed, supported ZIP. */
export function zipEntries(zip: Uint8Array): ZipEntry[] | null {
  if (zip.length < 22) return null;
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) { if (u32(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return null;
  const count = u16(eocd + 10);
  if (count > MAX_ZIP_ENTRIES) return null;
  let p = u32(eocd + 16);
  const out: ZipEntry[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || u32(p) !== 0x02014b50) return null;
    const flags = u16(p + 8);
    const method = u16(p + 10); const compressedSize = u32(p + 20); const size = u32(p + 24);
    const nlen = u16(p + 28); const elen = u16(p + 30); const clen = u16(p + 32); const localOffset = u32(p + 42);
    if (p + 46 + nlen > zip.length) return null;
    if ((flags & 0x1) === 0 && compressedSize !== 0xffffffff && size !== 0xffffffff && localOffset !== 0xffffffff) {
      out.push({ name: decoder.decode(zip.subarray(p + 46, p + 46 + nlen)), method, compressedSize, size, localOffset });
    }
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Bytes of one entry; null when unreadable, 'too_large' when it would exceed maxBytes. */
export function readEntry(zip: Uint8Array, e: ZipEntry, maxBytes = MAX_ENTRY_BYTES): Uint8Array | null | 'too_large' {
  if (e.size > maxBytes) return 'too_large';
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const local = e.localOffset;
  if (local + 30 > zip.length || dv.getUint32(local, true) !== 0x04034b50) return null;
  const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
  const data = zip.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) return null;
  if (e.method === 0) return data.length > maxBytes ? 'too_large' : data;
  if (e.method !== 8) return null;
  try { return new Uint8Array(inflateRawSync(data, { maxOutputLength: maxBytes })); } catch (err) {
    return (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : null;
  }
}

/** One named entry (exact match), bounded. */
export function readZipEntry(zip: Uint8Array, name: string, maxBytes = MAX_ENTRY_BYTES): Uint8Array | null | 'too_large' {
  const entries = zipEntries(zip);
  const e = entries?.find((x) => x.name === name);
  return e ? readEntry(zip, e, maxBytes) : null;
}
