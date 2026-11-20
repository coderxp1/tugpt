import type { Metadata } from 'next';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { asChatDb, listCapabilities, type CapabilityRow, type CapabilityState } from '@/lib/chat/store';
import { hasRegisteredTool } from '@/lib/chat/connect';
import { canManageConnections, isConnectProvider, oauthBanner, parseOAuthReturn, type ConnectProvider } from '@/lib/connect-ui/contract';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import { CHAT_MCP_EXECUTION_ENV } from '@/lib/chat/mcp';
import { routeAvailability } from '@/lib/connect-ui/routes.server';
import { McpPanel } from '@/components/connect/McpPanel';
import { OAuthBanner } from '@/components/connect/OAuthBanner';
import { ProviderActions } from '@/components/connect/ProviderActions';
import { StatusFreshness } from '@/components/connect/StatusFreshness';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connect · TuGPT' };

const STATE: Record<CapabilityState, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: s.ok },
  requires_connection: { label: 'Not connected', tone: s.idle },
  disabled_by_policy: { label: 'Turned off by your organization', tone: s.off },
  not_available: { label: 'Not available yet', tone: s.off },
};
const RANK: CapabilityState[] = ['connected', 'requires_connection', 'disabled_by_policy', 'not_available'];

const PROVIDER_COPY: Record<ConnectProvider, { blurb: string; next: Record<CapabilityState, string> }> = {
  google: {
    blurb: 'Calendar, Gmail and Drive for your Google Workspace account.',
    next: {
      connected: 'Type @ in Chat to use it.',
      requires_connection: 'Not connected. Until it is, TuGPT has no access to your Google data.',
      disabled_by_policy: 'An administrator of your organization has turned this provider off.',
      not_available: 'Connecting Google accounts is not switched on for TuGPT yet. Nothing is connected, and TuGPT has no access to your Google data.',
    },
  },
  microsoft: {
    blurb: 'Outlook calendar, mail and OneDrive for your Microsoft 365 account.',
    next: {
      connected: 'Type @ in Chat to use your Outlook calendar.',
      requires_connection: 'Not connected. Until it is, TuGPT has no access to your Microsoft data.',
      disabled_by_policy: 'An administrator of your organization has turned this provider off.',
      not_available: 'Connecting Microsoft 365 accounts is not switched on for TuGPT yet. Nothing is connected, and TuGPT has no access to your Microsoft data.',
    },
  },
};

/** Provider cards. Customer MCP rows (providerKey 'mcp') are managed in the MCP section, not as a provider card. */
function group(rows: readonly CapabilityRow[]) {
  const by = new Map<string, CapabilityRow[]>();
  for (const r of rows) if (r.providerKey !== 'mcp') by.set(r.providerKey, [...(by.get(r.providerKey) ?? []), r]);
  return [...by.entries()].map(([key, caps]) => ({
    key, name: caps[0].providerName, caps,
    state: RANK.find((st) => caps.some((c) => c.state === st)) ?? 'not_available',
  }));
}

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function ConnectPage({ searchParams }: { searchParams: Search }) {
  const [session, params] = await Promise.all([getSessionContext(), searchParams]);
  let rows: CapabilityRow[] | null = null;
  if (session?.tenant) {
    try { rows = await listCapabilities(asChatDb(await createAuthenticatedServerClient()), session.tenant.organizationId); } catch { rows = null; }
  }
  const checkedAt = new Date().toISOString();
  const providers = rows ? group(rows) : [];
  const canManage = canManageConnections(session?.tenant?.role);
  const routes = routeAvailability();
  const ret = parseOAuthReturn(params);
  const banner = ret ? oauthBanner(ret) : null;
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>Connect</p>
        <h1>Your apps, in every chat</h1>
        <p>Connect an account once, then type <kbd>@</kbd> in Chat to let TuGPT use it for that message. Connections are personal unless your administrator shares one with the organization.</p>
      </header>
      {banner && <OAuthBanner {...banner} />}
      {rows === null
        ? <p className={s.error} role="alert">Connection status could not be loaded. Nothing is shown as connected until it can be checked.</p>
        : <>
          <StatusFreshness checkedAt={checkedAt} />
          <p className={s.lead} data-testid="connect-summary" role="status">
            <strong>Your services:</strong>{' '}
            {(['connected', 'requires_connection', 'disabled_by_policy', 'not_available'] as const).map((st) => [st, providers.filter((p) => p.state === st).length] as const)
              .filter(([, n]) => n > 0).map(([st, n]) => `${n} ${STATE[st].label.toLowerCase()}`).join(' · ') || 'none listed'}
          </p>
        </>}
      <ul className={s.grid}>
        {providers.map((p) => {
          const copy = isConnectProvider(p.key) ? PROVIDER_COPY[p.key] : undefined;
          const st = STATE[p.state];
          const notInChat = p.caps.filter((c) => !hasRegisteredTool(c.capabilityKey, c.providerKey));
          return (
            <li key={p.key} className={s.card}>
              <div className={s.cardHead}>
                <span className={s.logo} aria-hidden="true">{p.name.charAt(0)}</span>
                <div><h2>{p.name}</h2>{copy && <p>{copy.blurb}</p>}</div>
                <span className={`${s.badge} ${st.tone}`}>{st.label}</span>
              </div>
              <h3 className={s.sub}>What TuGPT can do</h3>
              <ul className={s.caps}>
                {p.caps.map((c) => (
                  <li key={c.capabilityKey}>
                    <span>{c.description}{!hasRegisteredTool(c.capabilityKey, c.providerKey) && <em className={s.soon}> · not in Chat yet</em>}</span>
                    <small>{c.permissionClass === 'read' ? 'Read only' : 'Can make changes · blocked until approved'}</small>
                  </li>
                ))}
              </ul>
              <p className={s.next}>{copy?.next[p.state] ?? ''}</p>
              {isConnectProvider(p.key) && (
                <ProviderActions
                  provider={p.key}
                  state={p.state}
                  canManage={canManage}
                  start={p.key === 'google' ? routes.googleStart : routes.microsoftStart}
                  disconnect={p.key === 'google' ? routes.googleDisconnect : routes.microsoftDisconnect}
                />
              )}
              {notInChat.length > 0 && <p className={s.muted}>Chat has no tool for {notInChat.map((c) => c.description).join(', ')} on this build.</p>}
            </li>
          );
        })}
      </ul>
      <McpPanel canManage={canManage} routes={routes} enabled={customerMcpEnabled()} chatEnabled={process.env[CHAT_MCP_EXECUTION_ENV]?.trim() === 'true'} />
      <p className={s.foot}>You sign in on the provider&rsquo;s own page, so TuGPT never sees your password. Access is limited to the permissions listed on each card, and every use in Chat is recorded in your organization&rsquo;s audit log.</p>
    </div>
  );
}
