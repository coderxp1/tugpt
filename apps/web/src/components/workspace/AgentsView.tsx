'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import type { PublicModel } from '@/components/chat/types';
import type { Collection } from '@/lib/workspace-data/contracts';
import { agentCatalogue } from '@/lib/workspace/agents';
import { AGENT_LIMITS, agentsApi, cleanAgent, validateAgent, type AgentInput, type CustomAgent } from '@/lib/workspace/custom-agents';
import { hasArray, messageKeyFor, workspaceApi } from '@/lib/workspace/service';
import { WORKSPACE_HOME } from '@/lib/workspace/routes';
import { ActionMenu } from './ActionMenu';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { Badge, LoadingRows, ServiceNotice, When } from './states';
import { useLoad } from './useLoad';
import s from './pages.module.css';
import g from './agents.module.css';
import u from './ui.module.css';

export interface AgentsViewProps {
  readonly models?: readonly PublicModel[];
}

type Editing = { mode: 'new' } | { mode: 'edit'; agent: CustomAgent } | null;

/**
 * Agents. The built-in TuGPT Assistant is the Workspace chat and works today. Custom agents are
 * built in a dialog (name, description, instructions, model, starters, knowledge, visibility)
 * against contract C-1. The page probes GET /api/v1/agents: until it exists, the builder can be
 * opened and filled in, but saving is disabled and says why; nothing is listed that cannot run.
 */
function isBuilderAgent(value: unknown): value is CustomAgent {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<CustomAgent>;
  return typeof a.id === 'string' && typeof a.name === 'string' && typeof a.instructions === 'string'
    && Array.isArray(a.starters) && a.starters.every((v) => typeof v === 'string')
    && Array.isArray(a.collectionIds) && a.collectionIds.every((v) => typeof v === 'string');
}

export function AgentsView({ models = [] }: AgentsViewProps) {
  const t = useT();
  const { agents: builtIn } = agentCatalogue();
  const { load, reload, update } = useLoad<{ agents: readonly CustomAgent[] }>('agents', () => agentsApi().listAgents(), (v) => hasArray(v, 'agents') && (v as { agents: unknown[] }).agents.every(isBuilderAgent));
  const [editing, setEditing] = useState<Editing>(null);
  const [remove, setRemove] = useState<CustomAgent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A successful list request does not prove that the builder write contract is supported.
  // Agent 4's C-1 alignment is source-reviewed, not live-integrated here.
  // Keep writes off until the real API and end-to-end execution flow are verified.
  const canWrite = false;
  const available = load.state === 'ready';
  const custom = available ? load.value.agents : [];

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <header className={`${s.head} ${g.head}`}>
          <div>
            <p className={s.eyebrow}>{t('workspace.area.agents')}</p>
            <h1>{t('workspace.agents.title')}</h1>
            <p>{t('workspace.agents.intro')}</p>
          </div>
          <button type="button" className={u.buttonPrimary} onClick={() => setEditing({ mode: 'new' })}><Icon name="plus" size={15} />{t('workspace.agents.create')}</button>
        </header>

        <div role="status" aria-live="polite" className={g.live}>{notice && <p className={g.toast}>{notice}</p>}</div>

        <section className={s.section} aria-labelledby="agents-available">
          <div className={s.sectionHead}><h2 id="agents-available">{t('workspace.agents.available')}</h2></div>
          <ul className={s.grid}>
            {builtIn.map((a) => (
              <li key={a.id} className={s.card}>
                <div className={s.cardHead}>
                  <span className={s.mark} aria-hidden="true"><Icon name="sparkle" /></span>
                  <div><h3>{a.name}</h3><p>{t('workspace.agent.builtInDesc')}</p></div>
                </div>
                <div className={s.tags}>
                  <span className={s.tag}>{t('workspace.agents.tagBuiltIn')}</span>
                  <span className={s.tag}>{t('workspace.agents.tagOrg')}</span>
                  <span className={s.tag}>{t('workspace.agents.tagApps')}</span>
                </div>
                <div className={s.actions}>
                  <Link href={WORKSPACE_HOME} prefetch={false} className={s.primary}><Icon name="chat" size={16} />{t('workspace.agents.start')}</Link>
                </div>
              </li>
            ))}
            {custom.map((a) => (
              <li key={a.id} className={s.card}>
                <div className={s.cardHead}>
                  <span className={`${s.mark} ${s.markMuted}`} aria-hidden="true"><Icon name="agents" /></span>
                  <div className={g.cardText}><h3>{a.name}</h3>{a.description && <p>{a.description}</p>}</div>
                  {canWrite && a.ownedByMe && <ActionMenu label={t('workspace.agents.options', { name: a.name })} actions={[
                    { key: 'edit', label: t('workspace.agents.edit'), icon: 'pencil', onSelect: () => setEditing({ mode: 'edit', agent: a }) },
                    { key: 'delete', label: t('workspace.agents.delete'), icon: 'trash', danger: true, separated: true, onSelect: () => setRemove(a) },
                  ]} />}
                </div>
                <div className={s.tags}>
                  <Badge tone={a.visibility === 'organization' ? 'info' : 'neutral'}>{t(a.visibility === 'organization' ? 'workspace.lib.visOrg' : 'workspace.lib.visPrivate')}</Badge>
                  {a.collectionIds.length > 0 && <span className={s.tag}>{t('workspace.agents.sources', { count: a.collectionIds.length })}</span>}
                  <span className={g.updated}><When iso={a.updatedAt} prefix="workspace.lib.updated" /></span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className={s.section} aria-labelledby="agents-custom">
          <div className={s.sectionHead}><h2 id="agents-custom">{t('workspace.agents.yours')}</h2></div>
          {load.state === 'loading' && <LoadingRows label={t('workspace.agents.loading')} rows={1} tall />}
          {load.state === 'error' && <ServiceNotice problem={load.problem} failure={load.failure} feature={t('workspace.agents.customFeature')} detail={t('workspace.agents.customBody')} onRetry={reload} />}
          {available && custom.length === 0 && <p className={s.muted}>{t('workspace.agents.none')}</p>}
        </section>
      </div>

      {editing && (
        <AgentBuilder editing={editing} models={models} canSave={canWrite} onClose={() => setEditing(null)}
          onSaved={(agent, created) => {
            update((v) => ({ agents: created ? [agent, ...v.agents] : v.agents.map((x) => (x.id === agent.id ? agent : x)) }));
            setEditing(null);
            setNotice(t(created ? 'workspace.agents.created' : 'workspace.agents.saved', { name: agent.name }));
          }} />
      )}
      {remove && <DeleteAgent agent={remove} onClose={() => setRemove(null)} onDeleted={() => { update((v) => ({ agents: v.agents.filter((x) => x.id !== remove.id) })); setNotice(t('workspace.agents.deleted', { name: remove.name })); setRemove(null); }} />}
    </div>
  );
}

const EMPTY: AgentInput = { name: '', description: null, instructions: '', modelKey: null, starters: [''], collectionIds: [], visibility: 'private' };

function AgentBuilder({ editing, models, canSave, onClose, onSaved }: { editing: NonNullable<Editing>; models: readonly PublicModel[]; canSave: boolean; onClose(): void; onSaved(a: CustomAgent, created: boolean): void }) {
  const t = useT();
  const start = editing.mode === 'edit' ? editing.agent : null;
  const [form, setForm] = useState<AgentInput>(start ? { ...start, starters: start.starters.length ? [...start.starters] : [''] } : EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [touched, setTouched] = useState(false);
  const id = useId();
  const { load: cols } = useLoad<{ collections: readonly Collection[] }>('agent-builder-collections', () => workspaceApi().listCollections(), (v) => hasArray(v, 'collections'));
  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const problem = validateAgent(cleanAgent(form));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (problem || !canSave) return;
    setSaving(true); setError(null);
    const body = cleanAgent(form);
    const r = start ? await agentsApi().updateAgent(start.id, body) : await agentsApi().createAgent(body);
    setSaving(false);
    if (r.ok && r.value?.agent) onSaved(r.value.agent, !start);
    else setError(r.ok ? 'workspace.err.generic' : messageKeyFor(r));
  }

  return (
    <Dialog wide title={start ? t('workspace.agents.editTitle', { name: start.name }) : t('workspace.agents.builderTitle')} description={t('workspace.agents.builderIntro')} onClose={onClose}>
      <form onSubmit={save} className={u.dialogBody} noValidate>
        <label className={u.field} htmlFor={`${id}-name`}><span>{t('workspace.agents.f.name')}</span>
          <input id={`${id}-name`} value={form.name} maxLength={AGENT_LIMITS.name} onChange={(e) => set('name', e.target.value)} aria-invalid={touched && problem === 'name' ? true : undefined} aria-describedby={touched && problem === 'name' ? `${id}-name-err` : undefined} />
          {touched && problem === 'name' && <p id={`${id}-name-err`} className={u.fieldError}>{t('workspace.agents.v.name')}</p>}</label>

        <label className={u.field} htmlFor={`${id}-desc`}><span>{t('workspace.agents.f.description')}</span>
          <input id={`${id}-desc`} value={form.description ?? ''} maxLength={AGENT_LIMITS.description} onChange={(e) => set('description', e.target.value)} /></label>

        <label className={u.field} htmlFor={`${id}-ins`}><span>{t('workspace.agents.f.instructions')}</span>
          <textarea id={`${id}-ins`} rows={7} value={form.instructions} maxLength={AGENT_LIMITS.instructions} placeholder={t('workspace.agents.f.instructionsPlaceholder')}
            onChange={(e) => set('instructions', e.target.value)} aria-invalid={touched && problem === 'instructions' ? true : undefined} aria-describedby={`${id}-ins-help`} />
          <span className={g.fieldFoot}><span id={`${id}-ins-help`} className={u.help}>{touched && problem === 'instructions' ? <span className={u.fieldError}>{t('workspace.agents.v.instructions')}</span> : t('workspace.agents.f.instructionsHelp')}</span>
            <span className={u.counter} aria-hidden="true">{form.instructions.length.toLocaleString(t.locale)}/{AGENT_LIMITS.instructions.toLocaleString(t.locale)}</span></span></label>

        <label className={u.field} htmlFor={`${id}-model`}><span>{t('workspace.agents.f.model')}</span>
          <select id={`${id}-model`} value={form.modelKey ?? ''} onChange={(e) => set('modelKey', e.target.value || null)}>
            <option value="">{t('workspace.agents.f.modelAny')}</option>
            {models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select></label>

        <fieldset className={u.choices}>
          <legend>{t('workspace.agents.f.starters')}</legend>
          {form.starters.map((st, i) => (
            <div key={i} className={g.starter}>
              <label className={u.sr} htmlFor={`${id}-st-${i}`}>{t('workspace.agents.f.starterN', { n: i + 1 })}</label>
              <div className={u.field}><input id={`${id}-st-${i}`} value={st} maxLength={AGENT_LIMITS.starter} placeholder={t('workspace.agents.f.starterPlaceholder')} onChange={(e) => set('starters', form.starters.map((x, j) => (j === i ? e.target.value : x)))} /></div>
              {form.starters.length > 1 && <button type="button" className={u.iconButton} aria-label={t('workspace.agents.f.removeStarter', { n: i + 1 })} onClick={() => set('starters', form.starters.filter((_, j) => j !== i))}><Icon name="close" size={15} /></button>}
            </div>
          ))}
          {form.starters.length < AGENT_LIMITS.starters && <button type="button" className={u.buttonGhost} onClick={() => set('starters', [...form.starters, ''])}><Icon name="plus" size={15} />{t('workspace.agents.f.addStarter')}</button>}
        </fieldset>

        <fieldset className={u.choices}>
          <legend>{t('workspace.agents.f.knowledge')}</legend>
          {cols.state === 'loading' && <p className={u.help}>{t('workspace.lib.loading')}…</p>}
          {cols.state === 'error' && <p className={u.help}>{t('workspace.agents.f.knowledgeUnavailable')}</p>}
          {cols.state === 'ready' && cols.value.collections.length === 0 && <p className={u.help}>{t('workspace.agents.f.knowledgeNone')}</p>}
          {cols.state === 'ready' && cols.value.collections.map((col) => {
            const on = form.collectionIds.includes(col.id);
            return (
              <label key={col.id} className={u.choice}>
                <input type="checkbox" checked={on} onChange={() => set('collectionIds', on ? form.collectionIds.filter((x) => x !== col.id) : [...form.collectionIds, col.id])} />
                <span>{col.name}{col.description && <small>{col.description}</small>}</span>
              </label>
            );
          })}
        </fieldset>

        <fieldset className={u.choices}>
          <legend>{t('workspace.agents.f.visibility')}</legend>
          <div className={g.twoUp}>
            <label className={u.choice}><input type="radio" name={`${id}-vis`} checked={form.visibility === 'private'} onChange={() => set('visibility', 'private')} /><span>{t('workspace.lib.visPrivate')}<small>{t('workspace.agents.f.visPrivateHelp')}</small></span></label>
            <label className={u.choice}><input type="radio" name={`${id}-vis`} checked={form.visibility === 'organization'} onChange={() => set('visibility', 'organization')} /><span>{t('workspace.lib.visOrg')}<small>{t('workspace.agents.f.visOrgHelp')}</small></span></label>
          </div>
        </fieldset>

        {!canSave && <div className={u.notice}><Icon name="alert" size={16} /><div><strong>{t('workspace.agents.saveUnavailable')}</strong><p>{t('workspace.agents.saveUnavailableBody')}</p></div></div>}
        {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
        <div className={u.dialogFoot}>
          <button type="button" className={u.button} onClick={onClose}>{t('workspace.cancel')}</button>
          <button type="submit" className={u.buttonPrimary} disabled={!canSave || saving}>{saving ? t('workspace.saving') : start ? t('workspace.save') : t('workspace.agents.createButton')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteAgent({ agent, onClose, onDeleted }: { agent: CustomAgent; onClose(): void; onDeleted(): void }) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  return (
    <Dialog tone="alert" title={t('workspace.agents.deleteTitle', { name: agent.name })} description={t('workspace.agents.deleteBody')} onClose={onClose} footer={<>
      <button type="button" className={u.button} onClick={onClose} data-autofocus>{t('workspace.cancel')}</button>
      <button type="button" className={u.buttonDanger} disabled={working} onClick={async () => { setWorking(true); const r = await agentsApi().deleteAgent(agent.id); setWorking(false); if (r.ok) onDeleted(); else setError(messageKeyFor(r)); }}>{working ? t('workspace.working') : t('workspace.agents.deleteConfirm')}</button>
    </>}>
      {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
    </Dialog>
  );
}
