// Product Control Center — live probes.
//
// The health endpoint used to hardcode `database.available: false`. That was
// true on the author's machine and would have stayed "true" forever on a
// deployment with a working Supabase project, which is exactly the kind of
// invented state the Control Center exists to avoid. These probes ask.
//
// Scope is deliberately narrow: reachability and latency of the configured
// Supabase project, nothing tenant-scoped. The probe hits GoTrue's public
// `/auth/v1/health` with the anon key — the same thing the browser does on
// every page load — and reports status, never the body.

export interface DatabaseProbe {
  /** NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are both set. */
  configured: boolean;
  /** The project answered the health probe. null when not configured. */
  reachable: boolean | null;
  latencyMs: number | null;
  /** configured && reachable. What the UI shows as "connected". */
  available: boolean;
  /** Which host was probed (origin only, no path or key). null when not configured. */
  host: string | null;
  reason: string;
}

export interface ProbeOptions {
  url?: string;
  anonKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function probeDatabase(opts: ProbeOptions = {}): Promise<DatabaseProbe> {
  const url = (opts.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const anonKey = (opts.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2500;

  if (!url || !anonKey) {
    return {
      configured: false,
      reachable: null,
      latencyMs: null,
      available: false,
      host: null,
      reason:
        'No Supabase project is configured here (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY unset), so nothing that needs a database — usage totals, agent activity, production logs — can be read from this process.',
    };
  }

  let host: string;
  try {
    host = new URL(url).origin;
  } catch {
    return {
      configured: true,
      reachable: false,
      latencyMs: null,
      available: false,
      host: null,
      reason: 'NEXT_PUBLIC_SUPABASE_URL is set but is not a valid URL.',
    };
  }

  const started = Date.now();
  try {
    const res = await fetchImpl(`${host}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      return {
        configured: true,
        reachable: true,
        latencyMs,
        available: true,
        host,
        reason: `Supabase Auth at ${host} answered the health probe in ${latencyMs} ms. This proves the project is reachable from this process; tenant data still requires a signed-in session, which the Control Center deliberately does not have.`,
      };
    }
    return {
      configured: true,
      reachable: false,
      latencyMs,
      available: false,
      host,
      reason: `Supabase Auth at ${host} answered HTTP ${res.status} to the health probe. The project is configured but not healthy from this process.`,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const name = err instanceof Error ? err.name : 'Error';
    return {
      configured: true,
      reachable: false,
      latencyMs,
      available: false,
      host,
      reason: `Supabase at ${host} did not answer the health probe within ${timeoutMs} ms (${name}). The project is configured but unreachable from this process.`,
    };
  }
}
