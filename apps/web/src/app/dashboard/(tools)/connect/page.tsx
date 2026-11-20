import type { Metadata } from 'next';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { asChatDb, listCapabilities, type CapabilityRow, type CapabilityState } from '@/lib/chat/store';
import { hasRegisteredTool } from '@/lib/chat/connect';
import { canManageConnections, isConnectProvider, oauthBanner, parseOAuthReturn, PROVIDER_NAME } from '@/lib/connect-ui/contract';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import { CHAT_MCP_EXECUTION_ENV } from '@/lib/chat/mcp';
import { routeAvailability } from '@/lib/connect-ui/routes.server';
import { McpPanel } from '@/components/connect/McpPanel';
import { OAuthBanner } from '@/components/connect/OAuthBanner';
import { ProviderActions } from '@/components/connect/ProviderActions';
import { StatusFreshness } from '@/components/connect/StatusFreshness';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: createTranslator(await getRequestLocale())('connect.meta.title') };
}

const TONE: Record<CapabilityState, string> = { connected: s.ok, requires_connection: s.idle, disabled_by_policy: s.off, not_available: s.off };
const RANK: CapabilityState[] = ['connected', 'requires_connection', 'disabled_by_policy', 'not_available'];

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
  const [session, params, locale] = await Promise.all([getSessionContext(), searchParams, getRequestLocale()]);
  const t = createTranslator(locale);
  let rows: CapabilityRow[] | null = null;
  if (session?.tenant) {
    try { rows = await listCapabilities(asChatDb(await createAuthenticatedServerClient()), session.tenant.organizationId); } catch { rows = null; }
  }
  const checkedAt = new Date().toISOString();
  const providers = rows ? group(rows) : [];
  const canManage = canManageConnections(session?.tenant?.role);
  const routes = routeAvailability();
  const ret = parseOAuthReturn(params);
  const banner = ret ? oauthBanner(ret, t) : null;
  const capText = (c: CapabilityRow) => (c.providerKey === 'mcp' ? c.description : t.maybe(`connect.cap.${c.capabilityKey}`, c.description));
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>{t('connect.eyebrow')}</p>
        <h1>{t('connect.title')}</h1>
        <p>{t('connect.lead')}</p>
      </header>
      {banner && <OAuthBanner {...banner} />}
      {rows === null
        ? <p className={s.error} role="alert">{t('connect.loadFailed')}</p>
        : <>
          <StatusFreshness checkedAt={checkedAt} />
          <p className={s.lead} data-testid="connect-summary" role="status">
            <strong>{t('connect.summaryLabel')}</strong>{' '}
            {RANK.map((st) => [st, providers.filter((p) => p.state === st).length] as const)
              .filter(([, n]) => n > 0).map(([st, n]) => `${n} ${t(`connect.state.${st}`).toLocaleLowerCase(locale)}`).join(' · ') || t('connect.summaryNone')}
          </p>
        </>}
      <section className={s.legendBox} aria-labelledby="connect-legend">
        <h2 id="connect-legend">{t('connect.legend.title')}</h2>
        <dl className={s.legend} data-testid="connect-legend">
          {RANK.map((st) => (
            <div key={st}><dt><span className={`${s.badge} ${TONE[st]}`}>{t(`connect.state.${st}`)}</span></dt><dd>{t(`connect.legend.${st}`)}</dd></div>
          ))}
        </dl>
      </section>
      <ul className={s.grid}>
        {providers.map((p) => {
          const known = isConnectProvider(p.key) ? p.key : null;
          const name = known ? PROVIDER_NAME[known] : p.name;
          const notInChat = p.caps.filter((c) => !hasRegisteredTool(c.capabilityKey, c.providerKey));
          return (
            <li key={p.key} className={s.card} data-provider={p.key} data-state={p.state}>
              <div className={s.cardHead}>
                <span className={s.logo} aria-hidden="true">{p.name.charAt(0)}</span>
                <div><h2>{p.name}</h2>{known && <p>{t(`connect.provider.${known}.blurb`)}</p>}</div>
                <span className={`${s.badge} ${TONE[p.state]}`}>{t(`connect.state.${p.state}`)}</span>
              </div>
              <h3 className={s.sub}>{p.state === 'connected' ? t('connect.provider.canDo') : t('connect.provider.willProvide')}</h3>
              <ul className={s.caps}>
                {p.caps.map((c) => (
                  <li key={c.capabilityKey}>
                    <span>{capText(c)}{!hasRegisteredTool(c.capabilityKey, c.providerKey) && <em className={s.soon}> · {t('connect.provider.notInChatYet')}</em>}</span>
                    <small>{c.permissionClass === 'read' ? t('connect.perm.read') : t('connect.perm.changes')}</small>
                  </li>
                ))}
              </ul>
              {known && <p className={s.muted}>{t(`connect.provider.${known}.later`)}</p>}
              {known && p.state !== 'connected' && <>
                <h3 className={s.sub}>{t('connect.provider.how')}</h3>
                <ol className={s.howList}>
                  <li>{p.state === 'not_available' ? t('connect.provider.how1Later') : t('connect.provider.how1')}</li>
                  <li>{t('connect.provider.how2', { provider: name })}</li>
                  <li>{t('connect.provider.how3', { provider: name })}</li>
                </ol>
              </>}
              <p className={s.next}><strong>{t('connect.provider.status')} </strong>{t(`connect.provider.next.${p.state}`, { provider: name })}</p>
              {known && (
                <ProviderActions
                  provider={known}
                  state={p.state}
                  canManage={canManage}
                  start={known === 'google' ? routes.googleStart : routes.microsoftStart}
                  disconnect={known === 'google' ? routes.googleDisconnect : routes.microsoftDisconnect}
                />
              )}
              {notInChat.length > 0 && <p className={s.muted}>{t('connect.provider.noChatTool', { list: notInChat.map(capText).join(', ') })}</p>}
            </li>
          );
        })}
      </ul>
      <McpPanel canManage={canManage} routes={routes} enabled={customerMcpEnabled()} chatEnabled={process.env[CHAT_MCP_EXECUTION_ENV]?.trim() === 'true'} />
      <p className={s.foot}>{t('connect.foot')}</p>
    </div>
  );
}
