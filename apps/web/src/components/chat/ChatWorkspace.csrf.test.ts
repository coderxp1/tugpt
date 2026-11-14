import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MUTATION_HEADERS } from './ChatWorkspace';
import { isSameOriginMutation } from '@/lib/http/mutations';

const source = readFileSync(path.join(__dirname, 'ChatWorkspace.tsx'), 'utf8');

describe('chat client mutations pass the same-origin guard', () => {
  it('every POST in the chat client uses MUTATION_HEADERS', () => {
    const posts = source.match(/method: 'POST'[^}]*headers: [A-Z_]+/g) ?? [];
    expect(posts.length).toBe((source.match(/method: 'POST'/g) ?? []).length);
    for (const p of posts) expect(p).toMatch(/headers: MUTATION_HEADERS$/);
  });
  it('a browser request with those headers is accepted, and without the CSRF header refused', () => {
    process.env.TUGPT_APP_ORIGIN = 'https://dashboard.example';
    const mk = (h: Record<string, string>) => new Request('https://dashboard.example/api/v1/chat/threads', { method: 'POST', headers: { origin: 'https://dashboard.example', 'sec-fetch-site': 'same-origin', ...h }, body: '{}' });
    expect(isSameOriginMutation(mk({ ...MUTATION_HEADERS }))).toBe(true);
    expect(isSameOriginMutation(mk({ 'content-type': 'application/json' }))).toBe(false);
    delete process.env.TUGPT_APP_ORIGIN;
  });
});
