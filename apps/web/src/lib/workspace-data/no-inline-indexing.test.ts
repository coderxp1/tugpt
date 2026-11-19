/**
 * Q-8 regression guard: web requests must never index documents. Since
 * 20261120100002 the chunk writer `replace_document_chunks` is not executable
 * by the web role, and indexing is the knowledge worker's job. Any route or
 * library code that calls it again would fail at runtime with 403 after the
 * document row was created, which is exactly the bug Agent 3 reported.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const FORBIDDEN = /replace_document_chunks|complete_document_job|claim_document_jobs|\bindexDocument\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$|\.test-harness\.ts$/.test(e.name) ? [p] : [];
  });
}

describe('no inline indexing in the web app', () => {
  it('no web source calls the worker-only indexing functions', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
