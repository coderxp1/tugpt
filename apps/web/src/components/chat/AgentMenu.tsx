'use client';

import Link from 'next/link';
import { useCallback, useId, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { Icon } from '@/components/workspace/icons';
import { useDismiss } from '@/components/workspace/useDismiss';
import { agentCatalogue } from '@/lib/workspace/agents';
import { WORKSPACE_AGENTS } from '@/lib/workspace/routes';
import s from './chat.module.css';

/**
 * Which agent answers. Today the catalogue has one real agent, the TuGPT Assistant (the chat
 * itself); custom agents wait for the Agents API (lib/workspace/agents.ts, contract C-1).
 * The menu says that plainly instead of listing agents that cannot run.
 */
export function AgentMenu({ disabled, label }: { readonly disabled: boolean; readonly label?: string }) {
  const t = useT();
  const { agents, customAgentsAvailable } = agentCatalogue();
  const active = agents[0];
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback((restore: boolean) => { setOpen(false); if (restore) button.current?.focus(); }, []);
  useDismiss(open, root, close);

  return (
    <div className={s.menuRoot} ref={root}>
      <button ref={button} type="button" className={s.tool} disabled={disabled} aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={t('workspace.agent.button', { agent: label ?? active.name })} onClick={() => setOpen((o) => !o)}>
        <Icon name="agents" size={16} /><span className={`${s.toolText} ${s.hideNarrow}`}>{label ?? active.name}</span>
      </button>
      {open && (
        <div id={id} className={`${s.popover} ${s.agentPanel}`} role="group" aria-label={t('workspace.agent.choose')}>
          {!label && <ul className={s.agentList}>
            {agents.map((a) => (
              <li key={a.id} className={s.agentRow} aria-current="true">
                <span className={s.agentAvatar} aria-hidden="true"><Icon name="sparkle" size={16} /></span>
                <span><strong>{a.name}</strong><small>{t('workspace.agent.builtInDesc')}</small></span>
                <span className={s.modelCheck}><Icon name="check" size={16} /></span>
              </li>
            ))}
          </ul>}
          {label && <p className={s.agentNote}>{label}</p>}
          {!customAgentsAvailable && <p className={s.agentNote}>{t('workspace.agent.customLater')}</p>}
          <Link href={WORKSPACE_AGENTS} prefetch={false} className={s.agentLink} onClick={() => setOpen(false)}>{t('workspace.agent.browse')}</Link>
        </div>
      )}
    </div>
  );
}
