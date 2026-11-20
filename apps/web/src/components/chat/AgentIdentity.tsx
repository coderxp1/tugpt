'use client';

import { useT } from '@/i18n/provider';
import { BUILT_IN_AGENT } from '@/lib/workspace/agents';
import { Icon } from '@/components/workspace/icons';
import s from './chat.module.css';

/** Persistent identity, separate from the compact toolbar and its disabled states. */
export function AgentIdentity({ label }: { readonly label?: string }) {
  const t = useT();
  return <p className={s.conversationIdentity} role="status" aria-live="polite" aria-atomic="true">
    <Icon name="agents" size={16} />
    <span>{t('workspace.agent.button', { agent: label ?? BUILT_IN_AGENT.name })}</span>
  </p>;
}
