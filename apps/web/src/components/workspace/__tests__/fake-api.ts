/**
 * A tiny in-memory stand-in for Agent 4's Workspace API, routed by method + path, for component
 * tests. Shapes follow apps/web/src/lib/workspace-data/contracts.ts. Unknown routes answer like
 * this branch's server does for a route that is not deployed: Next's HTML 404.
 */
import { vi } from 'vitest';

export type Handler = (req: { method: string; url: URL; body: unknown; headers: Record<string, string> }) => { status?: number; body?: unknown } | undefined;

export const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const notDeployed = () => new Response('<!DOCTYPE html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } });

export function fakeApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; search: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'https://workspace.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = null;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ method, path: url.pathname, search: url.search, body, headers });
    for (const [pattern, handler] of Object.entries(routes)) {
      const [m, p] = pattern.split(' ');
      const re = new RegExp(`^${p.replace(/:[a-z]+/gi, '[^/]+')}$`);
      if (m === method && re.test(url.pathname)) {
        const r = handler({ method, url, body, headers });
        if (r) return json(r.status ?? 200, r.body ?? null);
      }
    }
    return notDeployed();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

export const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
