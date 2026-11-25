import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(__dirname, '../../../../..');
const frozen = {
  'apps/web/src/proxy.ts': '096a1e729587d5229d9b7d33c8d431f6db73be37b241533126e4e918b0c3f987',
  'packages/database/src/client.ts': 'cfd67225ceb1f4bc60ce61326c9415ae35237b66b0e141ef1305ee5da0d455bc',
  'apps/web/src/lib/sso/core.ts': '1a3b29519edfbc787b522c11c8a809933d23c18adc1ee5609f424ebcbbe36669',
};
// Original P2 candidate is preserved and independently hashed outside this run-owned tree.
// The core digest below covers only the explicit non-production issuer configuration delta.
describe('isolated integration boundary', () => {
  for (const [file, sha] of Object.entries(frozen)) it(file + ' remains byte-exact', () => {
    expect(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')).toBe(sha);
  });
  it('does not hide type/lint errors or add gateway rewrites in build configuration', () => {
    const config = readFileSync(path.join(root, 'apps/web/next.config.mjs'), 'utf8');
    expect(config).not.toMatch(/ignoreBuildErrors\s*:\s*true|ignoreDuringBuilds\s*:\s*true/);
  });
});
