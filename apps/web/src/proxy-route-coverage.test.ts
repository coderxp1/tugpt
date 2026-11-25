/**
 * classifyRoute() in proxy.ts used to be an allowlist of protected prefixes
 * with a public fallback:
 *
 *   if (/auth ...)        -> 'auth'
 *   if (/dashboard | /settings | /crm | /organizations) -> 'protected'
 *   return 'public'
 *
 * That failed open. A page added at a path nobody remembered to add to the
 * protected list was served by the proxy with no authentication check at all,
 * and nothing about writing that page would reveal it — the failure was
 * silence.
 *
 * As of 2026-08-24 it is inverted: anything not explicitly listed as `auth` or
 * `public` is `protected`. This file was written first, because inverting the
 * default is only safe once the full public surface is enumerated and each
 * entry has a recorded reason — and that is what the table below is.
 *
 * Both halves still earn their place, and they catch opposite mistakes:
 *
 *   - Deny-by-default stops an unlisted route from being *exposed*.
 *   - This table stops a route from being classified *silently*, either way.
 *     Under deny-by-default a forgotten route is unreachable rather than
 *     leaked, and unreachable is also a bug — one that now fails here rather
 *     than in production.
 *
 * The route table must match the app directory exactly, so a new route fails
 * the suite until somebody classifies it on purpose and records why. The last
 * test is the one with teeth: it fails the moment a page outside /auth becomes
 * reachable without an authentication check.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { classifyRoute, type RouteType } from './proxy';
import { APP_DIR, discoverRoutes, type RouteKind } from '../tests/support/app-routes';

interface RouteExpectation {
  path: string;
  kind: RouteKind;
  type: RouteType;
  /** Why this classification is correct. Required, especially for 'public'. */
  why: string;
}

const ROUTES: RouteExpectation[] = [
  { path: '/control-center', kind: 'page', type: 'operator', why: 'Product Control Center (ported from the mainline in C2): not a tenant surface; the proxy gates it with CONTROL_CENTER_TOKEN, never a tenant session.' },
  { path: '/api/v1/control-center/health', kind: 'api', type: 'operator', why: 'Control Center health probe: reports environment presence/reachability; operator-token gated by the proxy, no tenant session.' },
  { path: '/api/v1/control-center/lab', kind: 'api', type: 'operator', why: 'Control Center lab: executes product code on demand; operator-token gated by the proxy, no tenant session.' },
  { path: '/api/v1/connect/mcp/policy', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/oauth/start', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/oauth/callback/mcp', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/google/start', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/google/disconnect', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/microsoft/start', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/microsoft/disconnect', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/oauth/callback/google', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/oauth/callback/microsoft', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/endpoints', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/approvals', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/approvals/revoke', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/endpoints/[endpointId]', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/endpoints/[endpointId]/snapshot', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/endpoints/[endpointId]/activate', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/endpoints/[endpointId]/deactivate', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/snapshots/[snapshotId]/approve', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/v1/connect/mcp/snapshots/[snapshotId]/tools', kind: 'api', type: 'protected', why: 'Connect v2 handler authenticates via the session and enforces owner/admin role plus organization scoping.' },
  { path: '/api/auth/handoff', kind: 'api', type: 'auth', why: 'Accepted independent SSO handler enforces its own token, origin or opaque-session boundary.' },
  { path: '/api/auth/revoke', kind: 'api', type: 'auth', why: 'Accepted independent SSO handler enforces its own token, origin or opaque-session boundary.' },
  { path: '/api/auth/logout', kind: 'api', type: 'auth', why: 'Accepted independent SSO handler enforces its own token, origin or opaque-session boundary.' },
  { path: '/api/auth/session', kind: 'api', type: 'auth', why: 'Accepted independent SSO handler enforces its own token, origin or opaque-session boundary.' },
  { path: '/auth/complete', kind: 'api', type: 'auth', why: 'Accepted independent SSO handler enforces its own token, origin or opaque-session boundary.' },
  { path: '/api/v1/organizations/active', kind: 'api', type: 'public', why: 'Handler checks current membership; explicit selection requires configured-origin JSON and CSRF.' },

  { path: '/auth/website/start', kind: 'api', type: 'auth', why: 'Retired route: fixed410, no PKCE state or authentication side effects.' },
  { path: '/auth/website/callback', kind: 'api', type: 'auth', why: 'Retired route: fixed410, no code exchange or authentication side effects.' },
  { path: '/auth/website/error', kind: 'page', type: 'auth', why: 'Safe OAuth failure and membership guidance without sensitive provider error or account details.' },
  {
    path: '/',
    kind: 'page',
    type: 'public',
    // This reason used to read "Landing page. Renders no tenant data." True,
    // and useless: `/` was create-next-app boilerplate the entire time, and a
    // reason written about tenant data could never catch that. It now
    // redirects to the conversation inbox and renders nothing at all.
    why: 'Redirects to /workspace, the landing page after login. Renders nothing and reads nothing; the proxy gates the destination.',
  },
  {
    path: '/auth/login',
    kind: 'page',
    type: 'auth',
    why: 'Sign-in. Must be reachable while signed out.',
  },
  {
    path: '/auth/callback',
    kind: 'page',
    type: 'auth',
    why: 'OAuth/magic-link return leg. Runs before a session exists.',
  },
  {
    path: '/auth/logout',
    kind: 'page',
    type: 'auth',
    why: 'Clears the session; must not redirect to login on the way out.',
  },
  {
    path: '/dashboard/inbox',
    kind: 'page',
    type: 'protected',
    why: 'Unified conversation inbox. The proxy is the only gate on the page shell.',
  },
  {
    path: '/dashboard/drafts',
    kind: 'page',
    type: 'protected',
    why: 'Draft list. The proxy is the only gate on the page shell.',
  },
  {
    path: '/dashboard',
    kind: 'page',
    type: 'protected',
    why: 'Product hub. Shows organization-scoped counts read through the signed-in user, so it must never be served without a session.',
  },
  {
    path: '/dashboard/drafts/[draftId]',
    kind: 'page',
    type: 'protected',
    why: 'Draft detail. The proxy is the only gate on the page shell.',
  },
  {
    path: '/dashboard/media',
    kind: 'page',
    type: 'protected',
    why: 'Media job list. The proxy is the only gate on the page shell; the API routes behind it authenticate per request.',
  },
  {
    path: '/dashboard/media/new',
    kind: 'page',
    type: 'protected',
    why: 'Media job submission form. Same gate as the list it is reached from.',
  },
  {
    path: '/dashboard/media/[jobId]',
    kind: 'page',
    type: 'protected',
    why: 'Media job detail with private result preview. The proxy is the only gate on the page shell.',
  },
  {
    path: '/invite',
    kind: 'page',
    type: 'protected',
    why: 'Invitee side of a team invitation. Accepting requires a signed-in, freshly verified account, so the shell stays behind the session gate; the one-time token travels only in the URL fragment and is never sent to the server by the browser.',
  },
  {
    path: '/settings/integrations',
    kind: 'page',
    type: 'protected',
    why: 'Integration settings (Google Calendar connection state and actions). The proxy is the gate on the shell; the page itself resolves the session tenant and shows metadata only — credential material never reaches it.',
  },
  {
    path: '/dashboard/analytics',
    kind: 'page',
    type: 'protected',
    why: 'Usage & cost report. The proxy is the only gate on the page shell; the data itself comes from a membership-checked RPC.',
  },
  {
    path: '/dashboard/chat',
    kind: 'page',
    type: 'protected',
    why: 'Retired address kept for bookmarks: a server redirect (307) to /workspace. Renders and reads nothing; protected so it never answers a signed-out visitor differently.',
  },
  {
    path: '/workspace',
    kind: 'page',
    type: 'protected',
    why: 'Workspace chat shell. Threads and messages are loaded by the /api/v1/chat handlers through the user\'s RLS-bound client; owner-only per 20261115000001.',
  },
  {
    path: '/workspace/agents',
    kind: 'page',
    type: 'protected',
    why: 'Workspace agents page. Built-in assistant plus the public model catalogue (labels only); custom agents load client-side from /api/v1/agents (C-1) once it exists. Protected like the rest of /workspace.',
  },
  {
    path: '/workspace/library',
    kind: 'page',
    type: 'protected',
    why: 'Workspace library. Knowledge (GET /api/v1/knowledge) and collections (/api/v1/library/*) are fetched client-side (session, tenant, RLS to the active organization); the page itself only reads the session role.',
  },
  {
    path: '/workspace/approvals',
    kind: 'page',
    type: 'protected',
    why: 'Workspace approvals. History and decisions are fetched client-side from /api/v1/approvals (session, tenant, RLS; org scope and decisions re-checked for owner/admin); the page itself only reads the session role and user id.',
  },
  {
    path: '/workspace/images',
    kind: 'page',
    type: 'protected',
    why: 'Workspace image studio. Reuses ImageStudio, which calls /api/v1/create/images (session-gated, tenant-scoped). Renders no tenant data itself.',
  },
  {
    path: '/workspace/c/[threadId]',
    kind: 'page',
    type: 'protected',
    why: 'One Workspace chat. The thread is fetched by GET /api/v1/chat/threads/[id] through the user\'s RLS-bound client, so another person\'s id yields not-found.',
  },
  {
    path: '/dashboard/connect',
    kind: 'page',
    type: 'protected',
    why: 'Connect: integration catalogue and the caller\'s connection states from list_chat_capabilities(); metadata only, never credentials.',
  },
  {
    path: '/dashboard/create',
    kind: 'page',
    type: 'protected',
    why: 'Create: media generation entry point. Shows availability only; generation itself is not exposed by this page.',
  },
  {
    path: '/dashboard/settings',
    kind: 'page',
    type: 'protected',
    why: 'Profile and organization settings. Reads the session user and active membership only.',
  },

  // Every /api/v1 route below is 'public' to the proxy on purpose: the proxy
  // performs no authentication for them, and each handler authenticates for
  // itself via createAuthenticatedServerClient + AuthService, with RLS behind
  // it. Do not read 'public' here as "unauthenticated" — read it as "the proxy
  // is not the thing authenticating this".
  {
    path: '/api/v1/auth/session',
    kind: 'api',
    type: 'auth',
    why: 'Session probe. Answers "am I signed in", so it must run signed out.',
  },
  {
    path: '/api/v1/health',
    kind: 'api',
    type: 'public',
    why: 'Liveness probe. Returns no tenant data and is polled without credentials.',
  },
  {
    path: '/api/v1/webhooks/whatsapp',
    kind: 'api',
    type: 'public',
    why: 'Meta calls this unauthenticated; it is gated by HMAC signature and the hardcoded whatsapp_integration flag (ADR-010 amendment 2).',
  },
  {
    path: '/api/v1/organizations',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates: 401 without a user, 403 on an x-tenant-id the user does not belong to.',
  },
  {
    path: '/api/v1/drafts',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; RLS scopes the rows.',
  },
  {
    path: '/api/v1/drafts/[draftId]',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; RLS scopes the row.',
  },
  {
    path: '/api/v1/drafts/[draftId]/approve',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/delivery',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; the draft must be visible under the active org before the service-role delivery read.',
  },
  {
    path: '/api/v1/drafts/[draftId]/edit',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/reject',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the RPC enforces role and raises P3B02 otherwise.',
  },
  {
    path: '/api/v1/drafts/[draftId]/events',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; RLS scopes review events to the draft owner org.',
  },
  {
    path: '/api/v1/drafts/[draftId]/thread',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the feature gate before ' +
      'reading; RLS scopes messages to the org and the query scopes them to the ' +
      'conversation. Returns more customer text than any other route, so its ' +
      'serialised response shape is asserted field-by-field in thread-route.test.ts.',
  },
  {
    path: '/api/v1/conversations',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the same feature gate as the ' +
      'draft routes before reading; every query is scoped by organization_id and RLS ' +
      'scopes conversations to org members. Returns masked contacts and no message text ' +
      'at all, asserted in conversations-route.test.ts.',
  },
  {
    path: '/api/v1/chat/threads',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler authenticates and resolves the tenant strictly (stale hint = 403); RLS limits threads to their owner while an active member. Same-origin check on POST.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler authenticates and resolves the tenant; RLS returns the thread and messages only to their owner (pgTAP workspace_chat 18-23).',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/approved-call',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Same-origin POST; handler authenticates, loads the thread through RLS (owner only), re-validates capability, MCP gate, tool, model and argument hash (409 on mismatch), and the runtime claims the single-use approval and audits the call.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/rejected-call',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Same-origin POST; handler authenticates, loads the thread through RLS (owner only), and reject_tool_call() (requester or owner/admin) records rejected_by_user and revokes open approvals for exactly this call. Nothing runs.',
  },
  {
    path: '/api/v1/chat/approvals/status',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler authenticates and resolves the tenant; is_tool_approved() runs on the caller RLS client and only answers for the caller organization (503 on error, never true).',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/messages',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Same-origin POST; handler authenticates, re-validates @-mentions against list_chat_capabilities() and audits each tool call through record_connect_tool_call().',
  },
  {
    path: '/api/v1/chat/capabilities',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler authenticates and resolves the tenant; invoker-rights RPC returns catalogue states for the caller only, without connection ids.',
  },
  {
    path: '/api/v1/chat/capabilities/models',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler authenticates and resolves the tenant (chatContext); read-only list of opaque assistant capability ids and neutral labels (CONF-1). No provider, model, host or key; private no-store.',
  },
  {
    path: '/api/v1/chat/features',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler authenticates; read-only, row-less (limit 0) schema probes under the caller RLS report which backend contracts are available (Q-14). No rows, no secrets; private no-store.',
  },
  {
    path: '/api/v1/create/images',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler resolves the tenant strictly; organization comes from the session only (body fields are allow-listed); same-origin + CSRF header on POST; history is RLS-scoped to the owner while a member (pgTAP create_images 4-16).',
  },
  {
    path: '/api/v1/create/images/[imageId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Handler reads the row through RLS before any GPU call, so a colleague or another tenant gets 404 and the GPU is never asked (route.test.ts).',
  },
  {
    path: '/api/v1/create/images/[imageId]/cancel',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Same-origin + CSRF POST; ownership checked through RLS before the GPU cancel call.',
  },
  {
    path: '/api/v1/create/images/[imageId]/file',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: Owner-only via RLS; only magic-checked PNG bytes are returned, with nosniff, a sandbox CSP and private no-store.',
  },
  {
    path: '/api/v1/analytics/usage',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates and resolves tenant; the org_usage_summary RPC re-checks ' +
      'membership from the session claims (auth.uid()) inside the definer and returns an ' +
      'aggregate only — no per-row usage, no customer identifiers. provider_usage_events ' +
      'stays service_role-only; this is a read path over an aggregate, asserted in ' +
      'analytics-usage-route.test.ts.',
  },
  {
    path: '/dashboard/knowledge',
    kind: 'page',
    type: 'protected',
    why: 'FAQ management. The proxy is the only gate on the page shell; the data operations go through the knowledge API, whose authorization is the knowledge_entries RLS policy set.',
  },
  {
    path: '/api/v1/knowledge',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the draft feature gate; list ' +
      'and create run on the session client so the knowledge_entries policies decide ' +
      '(members read, owner/admin write — an agent insert returns 42501, mapped to 403). ' +
      'Asserted in knowledge-routes.test.ts.',
  },
  {
    path: '/api/v1/knowledge/[entryId]',
    kind: 'api',
    type: 'public',
    why:
      'Same handler shape; update and delete are organization-scoped in the query and ' +
      'policy-checked by RLS — a cross-organization id affects zero rows and returns ' +
      'the same 404 as a missing entry. Asserted in knowledge-routes.test.ts.',
  },
  {
    path: '/api/v1/knowledge/preview',
    kind: 'api',
    type: 'public',
    why:
      'Read-only retrieval preview: handler authenticates and gates like the other ' +
      'knowledge routes, reads the organization’s enabled entries under RLS, and runs ' +
      'the shared selectKnowledgeEntries — the same function the draft worker uses — ' +
      'so the preview cannot disagree with production drafting.',
  },
  {
    path: '/api/v1/conversations/[conversationId]/assign',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the feature gate; it then ' +
      'delegates every authorization decision to assign_conversation, which derives the ' +
      'organization from the locked row and raises P3C01/P3C02/P3C03 rather than trusting ' +
      'anything the caller sent. Asserted in assignment-routes.test.ts.',
  },
  {
    path: '/api/v1/conversations/[conversationId]/handoff',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates, resolves tenant, and passes the feature gate; the RPC owns ' +
      'membership, role, and the legal transitions. This is the switch that stops AI ' +
      'drafting for one customer, so the proxy classification being deliberate matters ' +
      'more here than anywhere else: it is public to the proxy and authenticated twice ' +
      'behind it. Asserted in assignment-routes.test.ts.',
  },
  {
    path: '/api/v1/organizations/me',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates (401 without a user) and reads/writes only the caller\'s own ' +
      'profile row through the own-row RLS policy and column grant; email is not writable.',
  },
  {
    path: '/api/v1/organizations/current',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates and resolves tenant (403 on a foreign x-tenant-id); writes go ' +
      'only through update_organization_settings, which enforces owner/admin and audits. ' +
      'Asserted in dashboard-team-routes.test.ts.',
  },
  {
    path: '/api/v1/organizations/current/transfer-ownership',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant; transfer_organization_ownership requires owner and audits.',
  },
  {
    path: '/api/v1/organizations/current/members',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant; member and profile visibility is RLS on the caller\'s client.',
  },
  {
    path: '/api/v1/organizations/current/members/[userId]',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates and resolves tenant; manage_organization_member owns role, rank, ' +
      'last-owner and cross-tenant rules and audits every change.',
  },
  {
    path: '/api/v1/invitations',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates and resolves tenant; create_invitation derives the ' +
      'organization from the caller\'s membership row and enforces role, rank and ' +
      'uniqueness. POST returns the one-time invitation token, which is why its ' +
      'logging is asserted field-by-field in invitation-routes.test.ts.',
  },
  {
    path: '/api/v1/invitations/[invitationId]/revoke',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates; revoke_invitation owns membership and role, and ' +
      'answers P3D01 for another tenant\'s invitation so ids cannot be probed.',
  },
  {
    path: '/api/v1/invitations/accept',
    kind: 'api',
    type: 'public',
    why:
      'Handler authenticates but deliberately resolves NO tenant: the caller is ' +
      'joining an organization they are not yet a member of, so the token carries ' +
      'the tenant and the RPC reads it from the locked row. The only route where ' +
      'the body rather than the session names the organization, which is why the ' +
      'token is a 244-bit server-generated secret.',
  },
  {
    path: '/api/v1/drafts/[draftId]/revisions',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; RLS scopes revisions to the draft owner org.',
  },
  {
    path: '/api/v1/media/jobs',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; per-lane quota gate and enqueue run through service_role RPCs, reads are RLS-scoped plus an explicit organization_id filter.',
  },
  {
    path: '/api/v1/media/jobs/[jobId]',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; the lookup is org-scoped so another org\u2019s job answers 404.',
  },
  {
    path: '/api/v1/media/jobs/[jobId]/cancel',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; cancellation runs through the service_role cancel_media_job RPC after an org-scoped existence check.',
  },
  {
    path: '/api/v1/media/jobs/[jobId]/result',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and resolves tenant context; the signed URL is minted service-side only after an org-scoped read authorizes the caller — no customer-facing storage policies exist on the private media bucket.',
  },
  {
    path: '/api/v1/integrations/google/start',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and requires the owner/admin role; the organization comes from the session (x-tenant-id is only a validated hint) and the minted OAuth state is HMAC-signed and bound to that user and organization.',
  },
  {
    path: '/api/v1/integrations/google/callback',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates; the organization and user come from the HMAC-signed state, membership and role are re-verified before the single-use code is exchanged, and outcomes redirect only to the fixed settings path.',
  },
  {
    path: '/api/v1/integrations/google/disconnect',
    kind: 'api',
    type: 'public',
    why: 'Handler authenticates and requires the owner/admin role; the organization comes from the session, and the outcome redirects only to the fixed settings path.',
  },
  // ---- Workspace backend (Agent 4) ----
  {
    path: '/api/v1/chat/folders',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); RLS limits folders to their owner while an active member. Same-origin check on POST.',
  },
  {
    path: '/api/v1/chat/folders/[folderId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); owner-only RLS; same-origin check on PATCH/DELETE; deleting un-files threads.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/attachments',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); thread must be the caller\'s; files RLS decides readability; same-origin check on POST.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/attachments/[fileId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); owner-only attachment RLS; same-origin check on DELETE.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/collections',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); thread must be the caller\'s; collection must be readable (can_read_collection); same-origin on POST.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/collections/[collectionId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); owner-only link RLS; same-origin check on DELETE.',
  },
  {
    path: '/api/v1/chat/threads/[threadId]/turns/[turnId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: GET only; handler resolves the tenant strictly via chatContext (stale hint = 403); thread must be the caller\'s open thread (getThread under RLS, else 404); messages read under the caller RLS, citations re-authorised (Q-12).',
  },
  {
    path: '/api/v1/approvals',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); history via list_approval_history (members: own; org scope owner/admin only); create via create_approval_request. Same-origin on POST.',
  },
  {
    path: '/api/v1/approvals/[requestId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); decide/revoke owner/admin and cancel requester-only, enforced in SQL; delegates to Agent 2 record/revoke_tool_approval.',
  },
  {
    path: '/api/v1/files',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); files RLS (owner, or ready org-visible); raw-body upload with origin + x-tugpt-csrf check, size cap and type allowlist.',
  },
  {
    path: '/api/v1/files/[fileId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); RLS: read own/org-visible, delete own or owner/admin for org-visible; same-origin on PATCH/DELETE.',
  },
  {
    path: '/api/v1/files/[fileId]/content',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); download only if the metadata row is readable under RLS; served as attachment with nosniff and sandbox CSP.',
  },
  {
    path: '/api/v1/library/collections',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); collections RLS (own or organization-visible); publishing to the organization requires owner/admin. Same-origin on POST.',
  },
  {
    path: '/api/v1/library/collections/[collectionId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); read via can_read_collection, write via can_write_collection; same-origin on PATCH/DELETE.',
  },
  {
    path: '/api/v1/library/collections/[collectionId]/documents',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); collection must be writable and the file readable (RLS); same-origin on POST.',
  },
  {
    path: '/api/v1/library/collections/[collectionId]/documents/[documentId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); writable collection only (RLS; request_document_reindex re-checks can_write_collection); same-origin on POST/DELETE; reindex rate limited per user.',
  },
  {
    path: '/api/v1/library/search',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); search_knowledge_hybrid is SECURITY INVOKER: chunk and embedding RLS (can_read_collection) apply at query time; rate limited per user.',
  },
  {
    path: '/api/v1/agents',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); custom_agents RLS (own private, org-visible readable by members; org agents need owner/admin to create); same-origin JSON on POST; agent.write rate limit.',
  },
  {
    path: '/api/v1/agents/[agentId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); can_read_agent/can_write_agent in RLS (403 readers, 404 others); instructions only returned to editors; same-origin on PATCH/DELETE.',
  },
  {
    path: '/api/v1/agents/[agentId]/collections',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); links need can_write_agent AND can_read_collection (RLS); unreadable collections are omitted on read; same-origin JSON on POST.',
  },
  {
    path: '/api/v1/agents/[agentId]/collections/[collectionId]',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); unlink needs can_write_agent (RLS); same-origin check on DELETE.',
  },
  {
    path: '/api/v1/agents/[agentId]/run',
    kind: 'api',
    type: 'protected',
    why: 'Proxy requires a session first (401 JSON). Then: handler resolves the tenant strictly via chatContext (stale hint = 403); agent must be readable (RLS); tools are the agent config intersected with the caller\'s own connected capabilities; knowledge searched under the caller\'s RLS; thread insert checked by RLS; same-origin JSON; agent.run rate limit.',
  },
];

describe('proxy route classification coverage', () => {
  it('finds the app router directory (guards against a cwd change breaking these tests silently)', () => {
    expect(existsSync(APP_DIR)).toBe(true);
    expect(discoverRoutes(APP_DIR).length).toBeGreaterThan(0);
  });

  it('lists every routable path in the app directory, and no path that does not exist', () => {
    const discovered = discoverRoutes(APP_DIR)
      .map((r) => r.path)
      .sort();
    const expected = ROUTES.map((r) => r.path).sort();

    // A failure here means a route was added or removed. Add it to ROUTES with
    // a deliberate classification and a reason — do not delete this assertion.
    expect(discovered).toEqual(expected);
  });

  it('classifies each route the way the table says', () => {
    for (const route of ROUTES) {
      expect(classifyRoute(route.path), `${route.path} — ${route.why}`).toBe(route.type);
    }
  });

  it('records a reason for every route the proxy does not authenticate', () => {
    for (const route of ROUTES.filter((r) => r.type === 'public')) {
      expect(route.why.length, `${route.path} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('leaves no page outside /auth reachable without an authentication check', () => {
    const unguarded = ROUTES.filter((r) => r.kind === 'page' && classifyRoute(r.path) === 'public').map(
      (r) => r.path
    );

    // The landing page is the only one, and it renders no tenant data. If this
    // list grows, a page is being served to anyone who asks for it.
    expect(unguarded).toEqual(['/']);
  });

  it('matches the app directory on kind as well as path', () => {
    const discovered = new Map(discoverRoutes(APP_DIR).map((r) => [r.path, r.kind]));
    for (const route of ROUTES) {
      expect(discovered.get(route.path), `${route.path} kind`).toBe(route.kind);
    }
  });
});

it('records held runtime prefixes separately from public handler classification', async () => {
  const { proxy } = await import('./proxy'); const { NextRequest } = await import('next/server');
  for (const prefix of ['/api/v1/media', '/api/v1/integrations', '/api/v1/workspace', '/api/v1/webhooks']) {
    for (const suffix of ['', '/x']) {
      const response = await proxy(new NextRequest('https://dashboard.example' + prefix + suffix));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'privileged_bridge_pending_review' });
    }
    expect(classifyRoute(prefix + 'other')).toBe('protected');
  }
});
