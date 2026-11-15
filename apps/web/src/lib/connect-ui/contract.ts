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
  mcpRegister: '/api/v1/connect/mcp/endpoints/route',
  mcpSnapshot: '/api/v1/connect/mcp/endpoints/[endpointId]/snapshot/route',
  mcpApprove: '/api/v1/connect/mcp/snapshots/[snapshotId]/approve/route',
  mcpActivate: '/api/v1/connect/mcp/endpoints/[endpointId]/activate/route',
  mcpDeactivate: '/api/v1/connect/mcp/endpoints/[endpointId]/deactivate/route',
} as const;
export type ContractRoute = keyof typeof CONTRACT_ROUTES;
export type RouteAvailability = Readonly<Record<ContractRoute, RouteState>>;

/** An action is offered when its route exists, or when presence cannot be checked (routes fail closed). */
export const usable = (s: RouteState) => s !== 'missing';

export const START_PATH: Record<ConnectProvider, string> = {
  google: '/api/v1/connect/google/start',
  microsoft: '/api/v1/connect/microsoft/start',
};

export interface BackendGap { readonly id: string; readonly title: string; readonly needs: string }

/** Work the frontend cannot do until the backend provides it. Shown verbatim in the UI and the report. */
export const BACKEND_GAPS = {
  B1: { id: 'B-1', title: 'List registered MCP servers', needs: 'GET /api/v1/connect/mcp/endpoints returning the organization\u2019s endpoints with status.' },
  B2: { id: 'B-2', title: 'Read discovered MCP tools', needs: 'GET /api/v1/connect/mcp/snapshots/{snapshotId}/tools returning name, description and input schema per tool.' },
  B3: { id: 'B-3', title: 'Outlook and MCP tools in chat', needs: 'Outlook calendar and active external MCP tools registered in the chat tool runtime.' },
  B4: { id: 'B-4', title: 'MCP tools in the @ picker', needs: 'Active MCP tools returned by list_chat_capabilities().' },
  B5: { id: 'B-5', title: 'Disconnect an account', needs: 'POST /api/v1/connect/{google,microsoft}/disconnect that revokes the token and marks the connected_accounts row revoked.' },
  B6: { id: 'B-6', title: 'Friendly start errors', needs: 'Start routes redirect to /settings/integrations?{provider}=error&reason=\u2026 instead of returning JSON to the browser.' },
  B7: { id: 'B-7', title: 'Per-call approval for MCP write tools', needs: 'A human approval step before write, irreversible or financial MCP tools run.' },
} as const satisfies Record<string, BackendGap>;

export const PROVIDER_NAME: Record<ConnectProvider, string> = { google: 'Google', microsoft: 'Microsoft 365' };

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
      : { tone: 'ok', title: `${name} is disconnected`, body: 'TuGPT no longer has access to this account.' };
  }
  return { tone: 'error', title: `${name} could not be connected`, body: REASON_TEXT[r.reason] };
}

export const canManageConnections = (role: string | null | undefined) => role === 'owner' || role === 'admin';
