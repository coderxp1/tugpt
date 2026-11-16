/**
 * Browser-safe description of the TuGPT Connect (v2) contract the dashboard
 * talks to, plus the human copy for every outcome it can report.
 *
 * Nothing here performs I/O. Route presence on the running build is decided
 * server-side (routes.server.ts); backend gaps that no build can satisfy yet
 * are listed in BACKEND_GAPS so the UI can name the exact dependency.
 */

export type ConnectProvider = 'google' | 'microsoft';
export type RouteState = 'available' | 'missing' | 'unknown';

/** Contract routes, as keys of Next's app-paths-manifest.json. */
export const CONTRACT_ROUTES = {
  googleStart: '/api/v1/connect/google/start/route',
  microsoftStart: '/api/v1/connect/microsoft/start/route',
  googleDisconnect: '/api/v1/connect/google/disconnect/route',
  microsoftDisconnect: '/api/v1/connect/microsoft/disconnect/route',
  /** GET lists, POST registers: one route file. */
  mcpRegister: '/api/v1/connect/mcp/endpoints/route',
  mcpDelete: '/api/v1/connect/mcp/endpoints/[endpointId]/route',
  mcpTools: '/api/v1/connect/mcp/snapshots/[snapshotId]/tools/route',
  mcpSnapshot: '/api/v1/connect/mcp/endpoints/[endpointId]/snapshot/route',
  mcpApprove: '/api/v1/connect/mcp/snapshots/[snapshotId]/approve/route',
  mcpActivate: '/api/v1/connect/mcp/endpoints/[endpointId]/activate/route',
  mcpDeactivate: '/api/v1/connect/mcp/endpoints/[endpointId]/deactivate/route',
} as const;
export type ContractRoute = keyof typeof CONTRACT_ROUTES;
export type RouteAvailability = Readonly<Record<ContractRoute, RouteState>>;

/** An action is offered when its route exists, or when presence cannot be checked (routes fail closed). */
export const usable = (s: RouteState) => s !== 'missing';

/** Strict variant for actions that must not run on a guess (customer MCP). */
export const present = (s: RouteState) => s === 'available';

export const START_PATH: Record<ConnectProvider, string> = {
  google: '/api/v1/connect/google/start',
  microsoft: '/api/v1/connect/microsoft/start',
};

export const DISCONNECT_PATH: Record<ConnectProvider, string> = {
  google: '/api/v1/connect/google/disconnect',
  microsoft: '/api/v1/connect/microsoft/disconnect',
};

export interface BackendGap { readonly id: string; readonly title: string; readonly needs: string }

/**
 * Work the frontend cannot do until the backend provides it. Shown verbatim in
 * the UI and the report. B-1..B-7 were delivered on integration/connect-dashboard;
 * these are what remains after wiring against that branch.
 */
export const BACKEND_GAPS = {
  EGRESS: { id: 'B-8', title: 'Customer MCP is switched off', needs: 'The egress proxy must pass its DNS-pinning, private-address-blocking and bypass-prevention probe, and tool discovery must go through it (it currently calls the server directly and follows redirects).' },
  MCP_RUNTIME: { id: 'B-9', title: 'MCP tools in chat', needs: 'Chat can run approved MCP tools through the egress proxy, but keeps them off until the backend can audit MCP calls (connect_tool_calls only accepts built-in capabilities and connected accounts). Members also need a read path for active MCP tools (external_tool_* is readable by owners and admins only), and endpoints that need credentials need a broker path.' },
  MCP_STATE: { id: 'B-10', title: 'Saved review state', needs: 'GET /api/v1/connect/mcp/endpoints should return each endpoint\u2019s latest snapshot id and whether it is approved, so a review can be resumed after a reload.' },
  CALL_APPROVAL: { id: 'B-11', title: 'Approve a single tool call', needs: 'POST /api/v1/connect/mcp/approvals records an approval, but there is no revoke route and no screen in chat to review a pending write call. Until then unapproved write calls are refused (APPROVAL_REQUIRED).' },
} as const satisfies Record<string, BackendGap>;

export const PROVIDER_NAME: Record<ConnectProvider, string> = { google: 'Google', microsoft: 'Microsoft 365' };
export const isConnectProvider = (k: string): k is ConnectProvider => k === 'google' || k === 'microsoft';

export type OAuthReturn =
  | { provider: ConnectProvider; outcome: 'connected' | 'revoked' }
  | { provider: ConnectProvider; outcome: 'error'; reason: OAuthReason };

const REASONS = ['invalid_callback', 'forbidden', 'not_configured', 'internal_error', 'provider_error', 'disconnect_failed'] as const;
export type OAuthReason = (typeof REASONS)[number] | 'unknown';

type Params = Readonly<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/** Whitelist parse of the callback redirect. Unknown values never reach the page. */
export function parseOAuthReturn(params: Params): OAuthReturn | null {
  for (const provider of ['google', 'microsoft'] as const) {
    const outcome = one(params[provider]);
    if (outcome === 'connected' || outcome === 'revoked') return { provider, outcome };
    if (outcome === 'error') {
      const r = one(params.reason);
      return { provider, outcome, reason: (REASONS as readonly string[]).includes(r ?? '') ? (r as OAuthReason) : 'unknown' };
    }
  }
  return null;
}

/** Query string to forward from /settings/integrations to /dashboard/connect; only whitelisted values. */
export function oauthReturnQuery(params: Params): string {
  const r = parseOAuthReturn(params);
  if (!r) return '';
  const q = new URLSearchParams({ [r.provider]: r.outcome });
  if (r.outcome === 'error') q.set('reason', r.reason);
  return `?${q.toString()}`;
}

const REASON_TEXT: Record<OAuthReason, string> = {
  invalid_callback: 'The sign-in response was incomplete or expired. Start again from this page.',
  forbidden: 'Only an organization owner or admin can connect this account.',
  not_configured: 'Connecting is not switched on for TuGPT yet. Nothing was connected.',
  internal_error: 'Something went wrong on our side. Nothing was connected; try again in a few minutes.',
  provider_error: 'The provider declined or cancelled the sign-in. Nothing was connected.',
  disconnect_failed: 'The account could not be disconnected. It may still be connected; check again before relying on it.',
  unknown: 'The connection did not complete. Nothing was connected.',
};

export function oauthBanner(r: OAuthReturn): { tone: 'ok' | 'error'; title: string; body: string } {
  const name = PROVIDER_NAME[r.provider];
  if (r.outcome !== 'error') {
    return r.outcome === 'connected'
      ? { tone: 'ok', title: `${name} is connected`, body: 'The status below was checked just now. Type @ in Chat to use it.' }
      : { tone: 'ok', title: `${name} is disconnected`, body: 'TuGPT revoked its access to this account. The status below was checked just now.' };
  }
  const title = r.reason === 'disconnect_failed' ? `${name} could not be disconnected` : `${name} could not be connected`;
  return { tone: 'error', title, body: REASON_TEXT[r.reason] };
}

export const canManageConnections = (role: string | null | undefined) => role === 'owner' || role === 'admin';
