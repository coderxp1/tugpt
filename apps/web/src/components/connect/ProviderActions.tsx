'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { PROVIDER_NAME, START_PATH, usable, type ConnectProvider, type RouteState } from '@/lib/connect-ui/contract';
import { disconnectProvider, disconnectText } from '@/lib/connect-ui/disconnect';
import { DisconnectDialog } from './DisconnectDialog';
import { useT } from '@/i18n/provider';
import s from './connect.module.css';

export interface ProviderActionsProps {
  provider: ConnectProvider;
  state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available';
  canManage: boolean;
  start: RouteState;
  /** Availability of POST /api/v1/connect/{provider}/disconnect on this build. */
  disconnect: RouteState;
  /** Injectable for tests. */
  disconnectFetch?: typeof fetch;
}

/** Connect / Use / Disconnect for one provider card. Only owners and admins get account actions. */
export function ProviderActions({ provider, state, canManage, start, disconnect, disconnectFetch }: ProviderActionsProps) {
  const t = useT();
  const name = PROVIDER_NAME[provider];
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setConfirming(false); trigger.current?.focus(); };

  /** Status shown afterwards always comes from a fresh server read, never from this result alone. */
  async function runDisconnect(): Promise<string | null> {
    const outcome = await disconnectProvider(provider, disconnectFetch);
    if (outcome === 'revoked') {
      router.replace(`/dashboard/connect?${provider}=revoked`);
      router.refresh();
      return null;
    }
    router.refresh();
    return disconnectText(outcome, name, t);
  }

  if (state === 'connected') {
    return (
      <div className={s.actionsRow}>
        <Link className={s.primary} href="/workspace">{t('connect.action.useInChat')}</Link>
        {canManage && <button ref={trigger} type="button" className={s.secondary} onClick={() => setConfirming(true)}>{t('connect.action.disconnect')}</button>}
        {confirming && (
          <DisconnectDialog
            providerName={name}
            onConfirm={usable(disconnect) ? runDisconnect : undefined}
            onClose={close}
            onDone={() => setConfirming(false)}
          />
        )}
      </div>
    );
  }
  if (state !== 'requires_connection') return null;
  if (!canManage) return <p className={s.muted}>{t('connect.action.onlyManagers', { provider: name })}</p>;
  if (!usable(start)) {
    return (
      <div className={s.actionsRow}>
        <button type="button" className={s.primary} disabled aria-describedby={`${provider}-start-missing`}>{t('connect.action.connect', { provider: name })}</button>
        <p id={`${provider}-start-missing`} className={s.muted}>{t('connect.action.notYet', { provider: name })}</p>
      </div>
    );
  }
  return (
    <div className={s.actionsRow}>
      {/* A real navigation: the provider's consent page must load top-level. */}
      <a className={s.primary} href={START_PATH[provider]} aria-busy={leaving} onClick={() => setLeaving(true)}>
        {leaving ? t('connect.action.opening', { provider: name }) : t('connect.action.connect', { provider: name })}
      </a>
      <p className={s.muted}>{t('connect.provider.how2', { provider: name })}</p>
    </div>
  );
}
