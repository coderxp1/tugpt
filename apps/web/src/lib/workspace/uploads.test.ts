import { describe, expect, it } from 'vitest';
import { formatBytes, kindOf, mediaTypeFor, routeFile, MAX_UPLOADS, UPLOAD_MAX_BYTES } from './uploads';

const f = (name: string, size: number, type = '') => ({ name, size, type });

describe('Workspace uploads: what happens to a picked file', () => {
  it('small text files go inside the message; the model reads them', () => {
    expect(routeFile(f('notes.md', 2000), 0)).toEqual({ kind: 'inline' });
    expect(routeFile(f('data.csv', 64 * 1024, 'text/csv'), 0)).toEqual({ kind: 'inline' });
  });
  it('documents and larger text files are uploaded', () => {
    expect(routeFile(f('contract.pdf', 300_000, 'application/pdf'), 0)).toEqual({ kind: 'upload' });
    expect(routeFile(f('plan.docx', 10_000), 0)).toEqual({ kind: 'upload' });
    expect(routeFile(f('big.csv', 200_000, 'text/csv'), 0)).toEqual({ kind: 'upload' });
    expect(routeFile(f('photo.JPG', 10_000, 'image/jpeg'), 0)).toEqual({ kind: 'upload' });
  });
  it('refuses with the reason', () => {
    expect(routeFile(f('empty.pdf', 0), 0)).toEqual({ kind: 'refuse', why: 'empty' });
    expect(routeFile(f('setup.exe', 10), 0)).toEqual({ kind: 'refuse', why: 'type' });
    expect(routeFile(f('huge.pdf', UPLOAD_MAX_BYTES + 1), 0)).toEqual({ kind: 'refuse', why: 'size' });
    expect(routeFile(f('a.pdf', 10), MAX_UPLOADS)).toEqual({ kind: 'refuse', why: 'count' });
    // A large text file the Files API does not take (e.g. .ts) is "too large" for the message, not "wrong type".
    expect(routeFile(f('big.ts', 200_000), 0)).toEqual({ kind: 'refuse', why: 'size' });
  });
  it('declares the type the server expects even when the browser reports none', () => {
    expect(mediaTypeFor(f('readme.md', 1))).toBe('text/markdown');
    expect(mediaTypeFor(f('sheet.xlsx', 1))).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mediaTypeFor(f('blob.bin', 1, 'application/x-thing'))).toBe('application/x-thing');
  });
  it('names kinds and sizes', () => {
    expect(kindOf('a.pptx')).toBe('slides');
    expect(kindOf('a.webp')).toBe('image');
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024, 'en')).toBe('25 MB');
  });
});
