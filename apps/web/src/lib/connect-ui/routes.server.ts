import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONTRACT_ROUTES, type ContractRoute, type RouteAvailability, type RouteState } from './contract';

/**
 * Which Connect contract routes this build actually contains, read from the
 * build's own route manifest. No request is made to the routes themselves:
 * the start routes have side effects (pending authorization rows).
 */
export function routeAvailability(manifestPath = path.join(process.cwd(), '.next', 'server', 'app-paths-manifest.json')): RouteAvailability {
  let keys: Set<string> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (parsed && typeof parsed === 'object') keys = new Set(Object.keys(parsed));
  } catch { keys = null; }
  const out = {} as Record<ContractRoute, RouteState>;
  for (const [k, route] of Object.entries(CONTRACT_ROUTES) as [ContractRoute, string][]) {
    out[k] = keys === null ? 'unknown' : keys.has(route) ? 'available' : 'missing';
  }
  return out;
}
