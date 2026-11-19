'use client';
import { useState } from 'react';
import type { Collection, CustomAgent } from '@/lib/workspace-data/contracts';
import { agentsApiAvailable } from '@/lib/workspace/agents';
import { hasArray, messageKeyFor, workspaceApi } from '@/lib/workspace/service';
import { useT } from '@/i18n/provider';
import { Dialog } from './Dialog';
import { LoadingRows, ServiceNotice } from './states';
import { useLoad } from './useLoad';
import u from './ui.module.css';

export function AgentCollectionsDialog({ agent, onClose, onChanged }: { agent: CustomAgent; onClose(): void; onChanged(): void }) {
  const t = useT();
  const options = useLoad<{ collections: readonly Collection[] }>('agent-options', () => workspaceApi().listCollections(), (v) => hasArray(v, 'collections'));
  const links = useLoad<{ collections: readonly Collection[] }>(agent.id, () => workspaceApi().listAgentCollections(agent.id), (v) => hasArray(v, 'collections'));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const allowed = agentsApiAvailable && agent.ownedByMe && agent.canEdit;
  async function toggle(col: Collection, linked: boolean) {
    if (!allowed || busy || links.load.state !== 'ready') return;
    setBusy(true); setNotice(null);
    const r = linked ? await workspaceApi().unlinkAgentCollection(agent.id, col.id) : await workspaceApi().linkAgentCollection(agent.id, col.id);
    setBusy(false);
    if (!r.ok) { setNotice(t(messageKeyFor(r))); return; }
    const confirmed = r.value && ('linked' in r.value ? r.value.linked === true : 'deleted' in r.value && r.value.deleted === true);
    if (!confirmed) { setNotice(t('workspace.err.generic')); return; }
    links.update((v) => ({ collections: linked ? v.collections.filter((c) => c.id !== col.id) : [...v.collections.filter((c) => c.id !== col.id), col] }));
    setNotice(t(linked ? 'workspace.agents.unlinked' : 'workspace.agents.linked'));
    onChanged();
  }
  return <Dialog title={t('workspace.agents.f.knowledge')} onClose={onClose}>
    <div className={u.dialogBody}>
      {[options, links].map(({ load, reload }, i) => load.state === 'loading' ? <LoadingRows key={i} label={t('workspace.lib.loading')} /> : load.state === 'error' ? <ServiceNotice key={i} problem={load.problem} failure={load.failure} feature={t('workspace.agents.f.knowledge')} onRetry={reload} /> : null)}
      {options.load.state === 'ready' && links.load.state === 'ready' && options.load.value.collections.map((col) => {
        const linked = links.load.state === 'ready' && links.load.value.collections.some((c) => c.id === col.id);
        return <label key={col.id} className={u.choice}><input type="checkbox" checked={linked} disabled={!allowed || busy} onChange={() => void toggle(col, linked)} /><span>{col.name}</span></label>;
      })}
      {options.load.state === 'ready' && options.load.value.collections.length === 0 && <p>{t('workspace.lib.empty')}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </Dialog>;
}
