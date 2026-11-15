/**
 * Customer-MCP activation gate.
 *
 * Activation is the point the endpoint becomes executable, so it is the place
 * the egress boundary is enforced at the application layer.
 *
 * Honest scope of this check:
 *   - `verifyEgressEnforced` proves the proxy URL is CONFIGURED and REACHABLE.
 *   - It does NOT prove the proxy's policy is active (CONNECT-only, private
 *     range blocking, DNS pinning) nor that broker/worker cannot bypass it.
 *     Those two properties are network-topology and proxy-policy facts that
 *     are only verifiable against the deployed proxy via the automated probe
 *     in docs/connect/egress-proxy/egress-probe.cjs.
 *
 * Therefore customer MCP stays DISABLED until the deployed probe passes: the
 * environment check + reachability probe below are necessary but not
 * sufficient, and are not proof of enforcement.
 */

export const EGRESS_PROXY_ENV = 'CONNECT_EGRESS_PROXY';

/** True only when the mandatory egress proxy URL is configured. */
export function isEgressConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EGRESS_PROXY_ENV];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Prove the proxy is REACHABLE (something is listening on the URL). A
 * CONNECT-only proxy answers a plain GET with 405; any HTTP response counts
 * as reachable, an error means unreachable. This does not verify the policy.
 */
export async function probeEgressProxy(proxyUrl: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchFn(proxyUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/** Configured AND reachable â€” a necessary, not sufficient, precondition. */
export async function verifyEgressEnforced(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const url = env[EGRESS_PROXY_ENV];
  if (typeof url !== 'string' || url.trim().length === 0) return false;
  return probeEgressProxy(url.trim(), fetchFn);
}

export type ActivationDecision = { ok: true } | { ok: false; reason: string };

/**
 * Pure decision function so the whole lifecycle gate is unit-testable.
 * Authorization (owner/admin), egress enforcement (configured + reachable),
 * and snapshot approval must ALL hold before an endpoint may become active.
 */
export function decideActivation(opts: {
  readonly role: string;
  readonly snapshotApproved: boolean;
  readonly egressEnforced: boolean;
}): ActivationDecision {
  if (opts.role !== 'owner' && opts.role !== 'admin') {
    return { ok: false, reason: 'activation requires the organization owner or admin role' };
  }
  if (!opts.egressEnforced) {
    return { ok: false, reason: 'egress enforcement is not verified (CONNECT_EGRESS_PROXY unset or unreachable); activation is refused' };
  }
  if (!opts.snapshotApproved) {
    return { ok: false, reason: 'no approved snapshot exists for this endpoint' };
  }
  return { ok: true };
}
