/**
 * Vendor-neutral blob storage for Workspace files.
 *
 * Security properties (all enforced here; tested in this package and apps/web):
 *   - Keys are DERIVED, never accepted: blobKey(org, fileId) with both parts
 *     validated as UUIDs. No caller-controlled path reaches a store.
 *   - Keys, endpoints, bucket names and credentials never leave the server:
 *     no URL is returned to clients and errors are generic (StorageError).
 *   - Not configured => configuredBlobStore() returns null and routes answer
 *     503 STORAGE_NOT_CONFIGURED (fail closed, no silent local fallback).
 *
 * Backends:
 *   fs  TUGPT_FILE_STORAGE=fs, TUGPT_FILE_STORAGE_DIR=/absolute/dir
 *   s3  TUGPT_FILE_STORAGE=s3, TUGPT_S3_ENDPOINT=https://..., TUGPT_S3_BUCKET,
 *       TUGPT_S3_REGION, TUGPT_S3_ACCESS_KEY_ID, TUGPT_S3_SECRET_ACCESS_KEY
 *       (any S3-compatible service: AWS S3, MinIO, Ceph RGW, R2, Hetzner, ...;
 *       path-style addressing; AWS Signature Version 4).
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BlobStore {
  readonly kind: 'fs' | 's3' | 'memory';
  put(key: string, data: Uint8Array, mediaType: string): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /**
   * Every object under a validated prefix ('org/', 'org/<uuid>/' or
   * 'org/<uuid>/files/'). Used only by maintenance (orphan sweep, org purge);
   * objects whose key does not match the derived-key shape are skipped.
   */
  list(prefix: string): AsyncIterable<BlobEntry>;
}

export interface BlobEntry { readonly key: string; readonly size: number; readonly modifiedAt: Date }

export class StorageError extends Error {
  constructor() { super('STORAGE_UNAVAILABLE'); this.name = 'StorageError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^org\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/;

export function blobKey(organizationId: string, fileId: string): string {
  const o = organizationId.toLowerCase(); const f = fileId.toLowerCase();
  if (!UUID.test(o) || !UUID.test(f)) throw new StorageError();
  return `org/${o}/files/${f}`;
}
function assertKey(key: string): void { if (!KEY.test(key)) throw new StorageError(); }
const PREFIX = /^org\/(?:[0-9a-f-]{36}\/(?:files\/)?)?$/;
function assertPrefix(prefix: string): void { if (!PREFIX.test(prefix)) throw new StorageError(); }
/** Organization prefix for listing/purging one tenant. */
export function orgPrefix(organizationId: string): string {
  const o = organizationId.toLowerCase();
  if (!UUID.test(o)) throw new StorageError();
  return `org/${o}/files/`;
}
/** Inverse of blobKey; null for anything that is not a derived key. */
export function parseBlobKey(key: string): { organizationId: string; fileId: string } | null {
  if (!KEY.test(key)) return null;
  const [, o, , f] = key.split('/');
  return UUID.test(o) && UUID.test(f) ? { organizationId: o, fileId: f } : null;
}

/** Server environment as read by storage config (a plain record, so tests need not fake NODE_ENV). */
export type StorageEnv = Readonly<Record<string, string | undefined>>;

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const HARD_MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // mirrors the DB CHECK on workspace_files.size_bytes

export function maxUploadBytes(env: StorageEnv = process.env): number {
  const v = env.TUGPT_FILE_MAX_BYTES;
  if (!v || !/^\d{1,9}$/.test(v)) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.min(Math.max(Number(v), 1), HARD_MAX_UPLOAD_BYTES);
}

// ------------------------------------------------------------------ filesystem
export class FilesystemBlobStore implements BlobStore {
  readonly kind = 'fs' as const;
  private readonly root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new StorageError();
    this.root = path.resolve(root);
  }
  private file(key: string): string {
    assertKey(key);
    const p = path.resolve(this.root, ...key.split('/'));
    if (!p.startsWith(this.root + path.sep)) throw new StorageError();
    return p;
  }
  async put(key: string, data: Uint8Array, _mediaType?: string): Promise<void> {
    void _mediaType; // the filesystem keeps no metadata; the DB row is authoritative
    const target = this.file(key);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      throw new StorageError();
    }
  }
  async get(key: string): Promise<Uint8Array | null> {
    const target = this.file(key);
    try { return new Uint8Array(await readFile(target)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StorageError();
    }
  }
  async delete(key: string): Promise<void> {
    const target = this.file(key);
    try { await rm(target, { force: true }); } catch { throw new StorageError(); }
  }
  async *list(prefix: string): AsyncIterable<BlobEntry> {
    assertPrefix(prefix);
    const parts = prefix.split('/').filter(Boolean); // ['org'] | ['org', o] | ['org', o, 'files']
    const dirs = async (p: string): Promise<string[]> => {
      try { return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new StorageError();
      }
    };
    const orgs = parts.length >= 2 ? [parts[1]] : (await dirs(path.join(this.root, 'org'))).filter((d) => UUID.test(d));
    for (const o of orgs) {
      const filesDir = path.join(this.root, 'org', o, 'files');
      let names: string[];
      try { names = await readdir(filesDir); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new StorageError();
      }
      for (const name of names.sort()) {
        if (!UUID.test(name)) continue; // *.tmp partial writes and foreign files are never reported
        try {
          const st = await stat(path.join(filesDir, name));
          if (st.isFile()) yield { key: `org/${o}/files/${name}`, size: st.size, modifiedAt: st.mtime };
        } catch { /* vanished between readdir and stat */ }
      }
    }
  }
}

// ------------------------------------------------------------------ in-memory (tests / local dev only)
export class MemoryBlobStore implements BlobStore {
  readonly kind = 'memory' as const;
  readonly objects = new Map<string, { data: Uint8Array; mediaType: string }>();
  async put(key: string, data: Uint8Array, mediaType: string) { assertKey(key); this.objects.set(key, { data: new Uint8Array(data), mediaType }); this.modified.set(key, new Date()); }
  async get(key: string) { assertKey(key); return this.objects.get(key)?.data ?? null; }
  async delete(key: string) { assertKey(key); this.objects.delete(key); this.modified.delete(key); }
  readonly modified = new Map<string, Date>();
  async *list(prefix: string): AsyncIterable<BlobEntry> {
    assertPrefix(prefix);
    for (const [key, o] of [...this.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (key.startsWith(prefix)) yield { key, size: o.data.length, modifiedAt: this.modified.get(key) ?? new Date(0) };
    }
  }
}

// ------------------------------------------------------------------ AWS SigV4
const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires; '/' kept for paths. */
export function uriEncode(s: string, keepSlash: boolean): string {
  return Array.from(new TextEncoder().encode(s)).map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export interface SigV4Input {
  readonly method: string;
  readonly host: string;
  readonly path: string; // already-encoded canonical URI
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>; // lower-case names, must include x-amz-date and x-amz-content-sha256
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Returns the Authorization header value. Pure; verified against AWS's published example. */
export function signV4(i: SigV4Input): string {
  const amzDate = i.headers['x-amz-date'];
  if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate)) throw new StorageError();
  const date = amzDate.slice(0, 8);
  const all: Record<string, string> = { host: i.host, ...i.headers };
  const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.entries(i.query ?? {})
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export interface S3Config {
  readonly endpoint: string; readonly bucket: string; readonly region: string;
  readonly accessKeyId: string; readonly secretAccessKey: string;
}
type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly base: URL;
  constructor(private readonly cfg: S3Config, private readonly fetchFn: FetchFn = (u, i) => fetch(u, i), private readonly now: () => Date = () => new Date()) {
    let u: URL;
    try { u = new URL(cfg.endpoint); } catch { throw new StorageError(); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new StorageError();
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket) || !/^[a-z0-9-]{1,32}$/.test(cfg.region)) throw new StorageError();
    if (!cfg.accessKeyId || !cfg.secretAccessKey) throw new StorageError();
    this.base = u;
  }
  private async send(method: 'PUT' | 'GET' | 'DELETE', key: string | null, body?: Uint8Array, mediaType?: string, query?: Record<string, string>): Promise<Response> {
    if (key !== null) assertKey(key);
    const basePath = this.base.pathname.replace(/\/+$/, '');
    const canonicalPath = `${basePath}/${uriEncode(this.cfg.bucket, false)}${key === null ? '' : `/${uriEncode(key, true)}`}`;
    const qs = Object.entries(query ?? {}).map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
    const payloadHash = sha256Hex(body ?? new Uint8Array());
    const amzDate = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const headers: Record<string, string> = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (mediaType) headers['content-type'] = mediaType;
    const authorization = signV4({ method, host: this.base.host, path: canonicalPath, query, headers, payloadHash, region: this.cfg.region,
      service: 's3', accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey });
    try {
      return await this.fetchFn(`${this.base.origin}${canonicalPath}${qs ? `?${qs}` : ''}`, {
        method, headers: { ...headers, authorization }, body: body as BodyInit | undefined, redirect: 'error', cache: 'no-store',
      });
    } catch { throw new StorageError(); }
  }
  async put(key: string, data: Uint8Array, mediaType: string): Promise<void> {
    const res = await this.send('PUT', key, data, mediaType);
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new StorageError();
  }
  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new StorageError(); }
    return new Uint8Array(await res.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    await res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 404) throw new StorageError();
  }
  /** ListObjectsV2, paginated with continuation tokens. */
  async *list(prefix: string): AsyncIterable<BlobEntry> {
    assertPrefix(prefix);
    let token: string | undefined;
    for (let page = 0; page < 100_000; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const res = await this.send('GET', null, undefined, undefined, query);
      if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new StorageError(); }
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = xmlText(m[1], 'Key');
        const modified = new Date(xmlText(m[1], 'LastModified') ?? '');
        const size = Number(xmlText(m[1], 'Size') ?? 'NaN');
        if (key && KEY.test(key) && !Number.isNaN(modified.getTime()) && Number.isFinite(size)) yield { key, size, modifiedAt: modified };
      }
      if (xmlText(xml, 'IsTruncated') !== 'true') return;
      token = xmlText(xml, 'NextContinuationToken') ?? undefined;
      if (!token) return;
    }
  }
}

function xmlText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
}

let testOverride: BlobStore | null | undefined;
/** Test hook. Not reachable from any route input. */
export function setBlobStoreForTests(store: BlobStore | null | undefined): void { testOverride = store; }

export function configuredBlobStore(env: StorageEnv = process.env): BlobStore | null {
  if (testOverride !== undefined) return testOverride;
  try {
    switch (env.TUGPT_FILE_STORAGE) {
      case 'fs':
        return env.TUGPT_FILE_STORAGE_DIR ? new FilesystemBlobStore(env.TUGPT_FILE_STORAGE_DIR) : null;
      case 's3':
        return new S3BlobStore({
          endpoint: env.TUGPT_S3_ENDPOINT ?? '', bucket: env.TUGPT_S3_BUCKET ?? '', region: env.TUGPT_S3_REGION ?? '',
          accessKeyId: env.TUGPT_S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.TUGPT_S3_SECRET_ACCESS_KEY ?? '',
        });
      default:
        return null;
    }
  } catch { return null; }
}
