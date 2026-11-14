import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ADR-021: the web process may call the credential broker but never embed its
// server, store or key ring. The package root re-exports all of those.
const dir = __dirname;
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('lib/chat separation', () => {
  it('scans a non-empty tree', () => { expect(files).toEqual(expect.arrayContaining(['connect.ts', 'turn.ts'])); });
  it('imports the credential broker only through its client module', () => {
    for (const f of files) {
      const specs = [...readFileSync(join(dir, f), 'utf8').matchAll(/from\s+'(@tugpt\/credential-broker[^']*)'/g)].map((m) => m[1]);
      for (const s of specs) expect(s, `${f} imports ${s}`).toBe('@tugpt/credential-broker/dist/client.js');
    }
  });
  it('never uses a service-role or admin client', () => {
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/service_role|createAdminClient|SUPABASE_SERVICE_ROLE/);
  });
});
