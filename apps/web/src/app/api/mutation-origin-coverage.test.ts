/**
 * Structural guard: every state-changing API route handler enforces the
 * CSRF/origin check, and in the Connect/Chat surfaces it does so before any
 * session, database, broker or egress work.
 *
 * Why structural: Agent 1 found deactivate and DELETE accepting a foreign
 * Origin (D7/X6) because the guard was added route-by-route and two routes
 * were forgotten; the Google/Microsoft disconnect routes were missed too.
 * This test fails the build the moment a new mutation route ships without it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isSameOriginMutation } from '@/lib/http/mutations';
import { isSameOriginRequest, readMutation } from '@/lib/workspace-data/http';

const API_ROOT = join(__dirname);
const MUTATION = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b/g;
const GUARDS = [
  'crossOriginMutationResponse(',
  'crossOriginFormResponse(',
  'isSameOriginMutation(',
  // Workspace API helpers (lib/workspace-data/http.ts): the same Origin + x-tugpt-csrf +
  // sec-fetch-site checks; readMutation also requires application/json. File uploads use
  // isSameOriginRequest because their body is binary. Equivalence is asserted below, so a
  // weakened helper fails this file instead of silently passing the scan.
  'isSameOriginRequest(',
  'readMutation(',
];
/** Not browser-session endpoints: authenticated by signature, not cookies. */
const EXEMPT_PREFIXES: Record<string, string> = {
  'v1/webhooks/': 'Inbound provider webhooks are authenticated by HMAC signature, not a browser session.',
  'v1/control-center/lab': 'Operator surface, not a browser-session endpoint: the proxy gates it with CONTROL_CENTER_TOKEN and rejects cross-origin requests before the handler runs; no tenant session cookie authenticates it.',
  'v1/control-center/platform/': 'Operator surface (B3 platform admin), not a browser-session endpoint: the proxy gates it with CONTROL_CENTER_TOKEN and rejects cross-origin requests before the handler runs; no tenant session cookie authenticates it.',
};
/** SSO/auth handlers enforce origin through lib/sso (origin(request, ...) + x-tugpt-csrf). */
const SSO_GUARD = /\borigin\(request\b|assertSsoMutation\(|sso\/routes/;
/**
 * Known, tracked gaps outside Agent 2 ownership. Listed explicitly so they are
 * visible; removing the gap requires removing the entry. Adding to this list
 * requires security review (CODEOWNERS).
 */
const KNOWN_GAPS: Record<string, string> = {
  'v1/media/jobs/route.ts': 'MediaJobForm does not send x-tugpt-csrf yet; server guard would break the UI. Tracked for Agent 1.',
  'v1/media/jobs/[jobId]/cancel/route.ts': 'MediaJobDetail does not send x-tugpt-csrf yet. Tracked for Agent 1.',
};
const SIDE_EFFECTS = /createAuthenticatedServerClient\(|createAdminSupabaseClient\(|createSsoControlClient\(|chatContext\(|createExternalMcpRepository\(|BrokerClient\(|listExternalMcpTools\(|createEgressMcpFetch\(/;
const STRICT_ORDER_PREFIXES = ['v1/connect/', 'v1/chat/', 'v1/integrations/'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return name === 'route.ts' ? [p] : [];
  });
}
const routes = walk(API_ROOT).map((p) => ({ rel: relative(API_ROOT, p).split('\\').join('/'), src: readFileSync(p, 'utf8') }));
const mutating = routes.filter((r) => { MUTATION.lastIndex = 0; return MUTATION.test(r.src); });

function handlerBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = new RegExp(MUTATION.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    const next = src.indexOf('\nexport ', start + 1);
    out.push({ name: m[1] ?? m[2], body: src.slice(start, next === -1 ? undefined : next) });
  }
  return out;
}

describe('mutation route origin/CSRF coverage', () => {
  it('finds the mutation routes (sanity: the scanner sees the Connect surface)', () => {
    const rels = mutating.map((r) => r.rel);
    for (const must of [
      'v1/connect/mcp/endpoints/route.ts',
      'v1/connect/mcp/endpoints/[endpointId]/route.ts',
      'v1/connect/mcp/endpoints/[endpointId]/deactivate/route.ts',
      'v1/connect/google/disconnect/route.ts',
      'v1/connect/microsoft/disconnect/route.ts',
    ]) expect(rels).toContain(must);
  });

  it('the Workspace guards accept and reject exactly what the canonical guard does (content type aside)', async () => {
    const origin = 'https://app.tugpt-guard.invalid';
    const prev = process.env.TUGPT_APP_ORIGIN;
    process.env.TUGPT_APP_ORIGIN = origin;
    try {
      const cases: Record<string, string>[] = [
        { origin, 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
        { origin: 'https://evil.example', 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
        { 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
        { origin, 'content-type': 'application/json' },
        { origin, 'x-tugpt-csrf': '0', 'content-type': 'application/json' },
        { origin, 'x-tugpt-csrf': '1', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
        { origin, 'x-tugpt-csrf': '1', 'content-type': 'text/plain' },
      ];
      for (const h of cases) {
        const req = () => new Request(`${origin}/api/v1/x`, { method: 'POST', headers: h, body: '{}' });
        const canonical = isSameOriginMutation(req());
        const ignoringType = isSameOriginMutation(new Request(`${origin}/api/v1/x`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' }));
        expect(isSameOriginRequest(req()), JSON.stringify(h)).toBe(ignoringType);
        const read = await readMutation(req(), []);
        expect(!(read instanceof Response) || read.status !== 403, JSON.stringify(h)).toBe(canonical);
      }
    } finally {
      if (prev === undefined) delete process.env.TUGPT_APP_ORIGIN; else process.env.TUGPT_APP_ORIGIN = prev;
    }
  });

  it('every mutation handler is guarded, exempt with a reason, or a listed known gap', () => {
    const unguarded = mutating
      .filter((r) => !Object.keys(EXEMPT_PREFIXES).some((p) => r.rel.startsWith(p)))
      .filter((r) => !GUARDS.some((g) => r.src.includes(g)) && !SSO_GUARD.test(r.src))
      .map((r) => r.rel)
      .sort();
    expect(unguarded, 'new mutation route without crossOriginMutationResponse()').toEqual(Object.keys(KNOWN_GAPS).sort());
  });

  it('Connect/Chat/Integrations handlers run the guard before any session, DB, broker or egress work', () => {
    const violations: string[] = [];
    for (const r of mutating.filter((x) => STRICT_ORDER_PREFIXES.some((p) => x.rel.startsWith(p)))) {
      for (const h of handlerBodies(r.src)) {
        const guardAt = Math.min(...GUARDS.map((g) => h.body.indexOf(g)).filter((i) => i >= 0));
        const effect = h.body.search(SIDE_EFFECTS);
        if (!Number.isFinite(guardAt)) violations.push(`${r.rel} ${h.name}: no guard`);
        else if (effect >= 0 && effect < guardAt) violations.push(`${r.rel} ${h.name}: side effect before guard`);
      }
    }
    expect(violations).toEqual([]);
  });
});
