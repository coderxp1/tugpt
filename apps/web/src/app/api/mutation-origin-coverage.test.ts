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

const API_ROOT = join(__dirname);
const MUTATION = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b/g;
const GUARDS = [
  'crossOriginMutationResponse(',
  'crossOriginFormResponse(',
  'isSameOriginMutation(',
];
/** Not browser-session endpoints: authenticated by signature, not cookies. */
const EXEMPT_PREFIXES: Record<string, string> = {
  'v1/webhooks/': 'Inbound provider webhooks are authenticated by HMAC signature, not a browser session.',
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
