'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BACKEND_GAPS, present, type RouteAvailability } from '@/lib/connect-ui/contract';
import { endpointStatusText, mcpApi, mcpIssue, newIdempotencyKey, permissionText, PERMISSION_LEVELS, SNAPSHOT_RETRY_SAME_KEY, validateEndpointInput, type McpEndpoint, type McpIssue, type McpTool, type PermissionLevel } from '@/lib/connect-ui/mcp';
import { createTranslator, formatDate, type Translator } from '@/i18n';
import { useT } from '@/i18n/provider';
import { ConfirmDialog } from './ConfirmDialog';
import { GapNote } from './GapNote';
import { McpToolReview } from './McpToolReview';
import s from './connect.module.css';

export interface McpPanelProps {
  canManage: boolean;
  routes: RouteAvailability;
  /** Server switch TUGPT_CUSTOMER_MCP_ENABLED. Off until the egress proxy passes its probe (B-8). */
  enabled: boolean;
  /** Server switch TUGPT_CHAT_MCP_EXECUTION_ENABLED: whether Chat may call active MCP tools at all. */
  chatEnabled?: boolean;
  /** Injectable for tests. */
  fetcher?: typeof fetch;
}

type ToolsState = 'none' | 'loading' | 'ready' | 'failed';
interface Row extends McpEndpoint { tools?: McpTool[]; toolsState: ToolsState; issue?: McpIssue }

const GROUP_ORDER = ['active', 'pending', 'disabled'] as const;
const EN = createTranslator('en');

/** "3 in total: 2 Read only, 1 Makes changes", from tools the backend returned. */
export function permissionSummary(tools: readonly McpTool[], t: Translator = EN): string {
  const parts = PERMISSION_LEVELS.map((l) => [l, tools.filter((x) => x.permissionClass === l).length] as const).filter(([, n]) => n > 0)
    .map(([l, n]) => `${n} ${permissionText(l, t).label}`);
  return `${t('mcp.tools.count', { count: tools.length })}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** Runs fn over items with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function IssueBox({ issue, t }: { issue: McpIssue; t: Translator }) {
  return (
    <div className={s.issue} role="alert">
      <p className={s.issueText}>{issue.text}</p>
      {issue.fix && <p className={s.issueFix}><strong>{t('mcp.err.fix')}</strong> {issue.fix}</p>}
      {issue.detail && <p className={s.issueFix}><small>{t('mcp.err.detail')} <span lang="en">{issue.detail}</span></small></p>}
    </div>
  );
}

/**
 * Customer-run MCP servers. The list and each server's latest tool list
 * (id, approved, count) come from GET /mcp/endpoints; tools and their
 * permission levels from GET /mcp/snapshots/{id}/tools. Every shown status is
 * the backend's, re-read after each action; nothing is assumed from a click.
 */
export function McpPanel({ canManage, routes, enabled, chatEnabled = false, fetcher }: McpPanelProps) {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadIssue, setLoadIssue] = useState<McpIssue | null>(null);
  const [url, setUrl] = useState(''); const [name, setName] = useState('');
  const [formIssue, setFormIssue] = useState<McpIssue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<Row | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  // M9: Idempotency-Key of a snapshot attempt whose outcome may still be pending, per endpoint; reused on retry.
  const pendingSnapshotKey = useRef(new Map<string, string>());
  // Tool lists are immutable per snapshot id, so a loaded list can be reused across re-reads.
  const toolCache = useRef(new Map<string, McpTool[]>());

  const canList = canManage && present(routes.mcpRegister);
  const can = {
    register: enabled && present(routes.mcpRegister),
    discover: enabled && present(routes.mcpSnapshot) && present(routes.mcpTools),
    approve: enabled && present(routes.mcpApprove),
    activate: enabled && present(routes.mcpActivate),
    deactivate: present(routes.mcpDeactivate),
    remove: present(routes.mcpDelete),
  };

  const patch = (id: string, p: Partial<Row>) => setRows((all) => all?.map((e) => (e.id === id ? { ...e, ...p } : e)) ?? all);

  /** Re-reads the list, then the saved tool list of every server that has one. Returns the fresh rows. */
  const reload = useCallback(async (): Promise<Row[] | null> => {
    const r = await mcpApi.list(fetcher);
    if (!r.ok) { setLoadIssue(mcpIssue(r, t)); setRows((prev) => prev ?? []); return null; }
    setLoadIssue(null);
    const fresh: Row[] = r.data.map((e) => {
      const cached = e.snapshot ? toolCache.current.get(e.snapshot.id) : undefined;
      return { ...e, tools: cached, toolsState: !e.snapshot ? 'none' : cached ? 'ready' : 'loading' };
    });
    setRows(fresh);
    const todo = fresh.filter((e) => e.snapshot && e.toolsState === 'loading');
    await pool(todo, 4, async (e) => {
      const res = await mcpApi.tools(e.snapshot!.id, fetcher);
      if (res.ok) { toolCache.current.set(e.snapshot!.id, res.data); patch(e.id, { tools: res.data, toolsState: 'ready' }); }
      else patch(e.id, { toolsState: 'failed', issue: { text: t('mcp.err.toolsRead'), fix: mcpIssue(res, t).fix } });
    });
    return fresh;
  }, [fetcher, t]);

  // State is only set once requests settle; the call is deferred so nothing updates during the effect itself.
  useEffect(() => {
    if (!canList) return;
    let live = true;
    void Promise.resolve().then(() => { if (live) void reload(); });
    return () => { live = false; };
  }, [canList, reload]);

  async function register(ev: React.FormEvent) {
    ev.preventDefault();
    if (!can.register) return;
    const invalid = validateEndpointInput(url, name, t);
    if (invalid) { setFormIssue({ text: invalid }); return; }
    setBusy('register'); setFormIssue(null); setNotice('');
    const r = await mcpApi.register(url, name, fetcher);
    setBusy(null);
    if (!r.ok) { setFormIssue(mcpIssue(r, t)); return; }
    const added = name.trim();
    setUrl(''); setName('');
    await reload();
    setNotice(t('mcp.form.added', { name: added }));
  }

  async function discover(e: Row) {
    if (!can.discover) return;
    setBusy(`snapshot:${e.id}`); patch(e.id, { issue: undefined }); setNotice('');
    const key = pendingSnapshotKey.current.get(e.id) ?? newIdempotencyKey();
    pendingSnapshotKey.current.set(e.id, key);
    const r = await mcpApi.snapshot(e.id, fetcher, key);
    // Keep the key only while a retry could still return the original; otherwise the next click starts afresh.
    if (r.ok || !SNAPSHOT_RETRY_SAME_KEY.has(r.code)) pendingSnapshotKey.current.delete(e.id);
    if (r.ok) {
      await reload();
      setNotice(t('mcp.done.discovered', { count: r.data.toolCount, name: e.displayName }));
    } else patch(e.id, { issue: mcpIssue(r, t) });
    setBusy(null);
  }

  async function approve(e: Row, permissions: Record<string, PermissionLevel>): Promise<string | null> {
    if (!e.snapshot || !can.approve) return t('mcp.approve.off');
    const r = await mcpApi.approve(e.snapshot.id, permissions, fetcher);
    if (r.ok || r.code === 'ALREADY_APPROVED') {
      // The approved levels are stored per tool; drop the cached pre-approval list and read it again.
      toolCache.current.delete(e.snapshot.id);
      const fresh = await reload();
      const now = fresh?.find((x) => x.id === e.id);
      if (now?.snapshot?.approved) { setNotice(t('mcp.done.approved', { name: e.displayName })); return null; }
      return mcpIssue({ ok: false, status: 502, code: 'BAD_RESPONSE', message: '' }, t).text;
    }
    const i = mcpIssue(r, t);
    return i.fix ? `${i.text} ${i.fix}` : i.text;
  }

  async function toggle(e: Row, action: 'activate' | 'deactivate') {
    if (action === 'activate' ? !can.activate || !e.snapshot?.approved : !can.deactivate) return;
    setBusy(`${action}:${e.id}`); patch(e.id, { issue: undefined }); setNotice('');
    const r = action === 'activate' ? await mcpApi.activate(e.id, fetcher) : await mcpApi.deactivate(e.id, fetcher);
    // Re-read first so the shown status is the backend's; then attach any error to the fresh row.
    const fresh = await reload();
    if (!r.ok) patch(e.id, { issue: mcpIssue(r, t) });
    else {
      const now = fresh?.find((x) => x.id === e.id);
      if (now?.status === 'active' && action === 'activate') setNotice(t('mcp.done.on', { name: e.displayName }));
      if (now && now.status !== 'active' && action === 'deactivate') setNotice(t('mcp.done.off', { name: e.displayName }));
    }
    setBusy(null);
  }

  async function remove(e: Row): Promise<string | null> {
    const r = await mcpApi.remove(e.id, fetcher);
    if (!r.ok) { const i = mcpIssue(r, t); return i.fix ? `${i.text} ${i.fix}` : i.text; }
    if (r.data.deleted !== true) { await reload(); return t('mcp.remove.unconfirmed'); }
    await reload();
    setNotice(t('mcp.done.removed', { name: e.displayName }));
    return null;
  }

  const closeDelete = () => { setDeleting(null); deleteTrigger.current?.focus(); };
  const lockedNote = <p className={s.muted}>{!enabled ? t('mcp.locked.off') : t('mcp.locked.na')}</p>;
  const groupTitle = (g: (typeof GROUP_ORDER)[number]) => t(`mcp.group.${g}`);

  function nextStep(e: Row): string {
    if (e.status === 'active') return chatEnabled ? t('mcp.next.activeChat') : t('mcp.next.active');
    if (e.snapshot?.approved) return e.status === 'disabled' ? t('mcp.next.disabled') : t('mcp.next.approved');
    if (e.snapshot) return t('mcp.next.review');
    return enabled ? t('mcp.next.discover') : t('mcp.next.blocked');
  }
  function approvalFact(e: Row): string {
    if (!e.snapshot) return t('mcp.approval.none');
    if (!e.snapshot.approved) return t('mcp.approval.pending');
    if (!e.tools) return t('mcp.approval.approved');
    return e.tools.some((x) => x.permissionClass !== 'read') ? t('mcp.approval.approvedChanges') : t('mcp.approval.approvedRead');
  }
  function toolsFact(e: Row): string {
    if (!e.snapshot) return t('mcp.tools.none');
    if (e.tools) return permissionSummary(e.tools, t);
    if (e.toolsState === 'loading') return t('mcp.tools.loading');
    return t('mcp.tools.count', { count: e.snapshot.toolCount });
  }

  const approvedTools = rows?.reduce((n, r) => n + (r.snapshot?.approved ? r.snapshot.toolCount : 0), 0) ?? 0;
  const waitingTools = rows?.reduce((n, r) => n + (r.snapshot && !r.snapshot.approved ? r.snapshot.toolCount : 0), 0) ?? 0;

  return (
    <section className={s.section} aria-labelledby="mcp-title">
      <h2 id="mcp-title">{t('mcp.title')}</h2>
      <p className={s.lead}>{t('mcp.lead')}</p>
      <ol className={s.steps} aria-label={t('mcp.steps.label')}>
        {([1, 2, 3, 4] as const).map((n) => <li key={n}><strong>{t(`mcp.step${n}.title`)}</strong> {t(`mcp.step${n}.body`)}</li>)}
      </ol>
      <p className={s.muted} data-testid="mcp-chat-status"><strong>{t('mcp.chat.label')}</strong> {chatEnabled ? t('mcp.chat.on') : t('mcp.chat.off')}</p>
      {!enabled && <GapNote gap={BACKEND_GAPS.EGRESS} label={t('connect.gap.notEnabled')}>{t('mcp.disabled.note')}</GapNote>}

      {!canManage ? <p className={s.muted} data-testid="mcp-members-only">{t('mcp.membersOnly')}</p> : (
        <>
          <form className={s.form} onSubmit={(e) => void register(e)} noValidate>
            <fieldset disabled={!can.register || busy === 'register'}>
              <legend className={s.sr}>{t('mcp.form.legend')}</legend>
              <label>{t('mcp.form.name')}<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} placeholder={t('mcp.form.namePh')} /></label>
              <label>{t('mcp.form.url')}<input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" autoComplete="off" placeholder="https://mcp.example.com/sse" aria-describedby="mcp-url-help" /></label>
              <small id="mcp-url-help">{t('mcp.form.urlHelp')}</small>
              <button type="submit" className={s.primary} disabled={!can.register || busy === 'register'}>{busy === 'register' ? t('mcp.form.adding') : t('mcp.form.add')}</button>
            </fieldset>
            {formIssue && <IssueBox issue={formIssue} t={t} />}
          </form>

          <p className={notice ? s.okNote : s.sr} role="status" data-testid="mcp-notice">{notice}</p>

          {!canList && <p className={s.muted} role="note">{t('mcp.list.unavailable')}</p>}
          {canList && rows === null && <p className={s.muted} role="status">{t('mcp.list.loading')}</p>}
          {loadIssue && (
            <div className={s.actionsRow}>
              <IssueBox issue={{ text: `${t('mcp.list.failed')} ${loadIssue.text}`, fix: loadIssue.fix }} t={t} />
              <button type="button" className={s.secondary} onClick={() => void reload()}>{t('mcp.list.retry')}</button>
            </div>
          )}
          {rows !== null && rows.length === 0 && !loadIssue && <p className={s.muted}>{t('mcp.list.empty')}</p>}
          {rows !== null && rows.length > 0 && (<>
            <div className={s.mcpSummary} data-testid="mcp-summary" role="group" aria-label={t('mcp.summary.label')}>
              {GROUP_ORDER.map((g) => <p key={g} data-group={g}><strong>{rows.filter((r) => r.status === g).length}</strong><span>{groupTitle(g)}</span></p>)}
              <p data-summary="approved"><strong>{approvedTools}</strong><span>{t('mcp.summary.toolsApproved')}</span></p>
              <p data-summary="waiting"><strong>{waitingTools}</strong><span>{t('mcp.summary.toolsWaiting')}</span></p>
              <p data-summary="chat"><strong>{chatEnabled ? t('mcp.summary.yes') : t('mcp.summary.notYet')}</strong><span>{t('mcp.summary.chat')}</span></p>
            </div>
            {enabled && <p className={s.muted}>{t('mcp.unlockNote')}</p>}
            {GROUP_ORDER.filter((g) => rows.some((r) => r.status === g)).map((g) => (
            <section key={g} className={s.mcpGroup} aria-labelledby={`mcp-group-${g}`}>
            <h3 id={`mcp-group-${g}`}>{groupTitle(g)} <span className={s.count}>({rows.filter((r) => r.status === g).length})</span></h3>
            <ul className={s.endpoints} aria-label={t('mcp.group.listLabel', { group: groupTitle(g) })}>
              {rows.filter((r) => r.status === g).map((e) => (
                <li key={e.id} className={s.card} data-endpoint={e.id} data-approved={e.snapshot?.approved ? 'true' : 'false'}>
                  <div className={s.endpointHead}>
                    <h4>{e.displayName}</h4>
                    <span className={`${s.badge} ${e.status === 'active' ? s.ok : e.status === 'pending' ? s.idle : s.off}`}>{endpointStatusText(e.status, t)}</span>
                  </div>
                  <p className={s.url}>{e.url}</p>
                  <dl className={s.mcpFacts}>
                    <div><dt>{t('mcp.fact.tools')}</dt><dd>{toolsFact(e)}</dd></div>
                    <div><dt>{t('mcp.fact.approval')}</dt><dd>{approvalFact(e)}</dd></div>
                    <div><dt>{t('mcp.fact.chat')}</dt><dd>{chatEnabled ? e.status === 'active' ? t('mcp.inChat.usable') : t('mcp.inChat.afterOn') : t('mcp.inChat.no')}</dd></div>
                    {e.createdAt && <div><dt>{t('mcp.fact.added')}</dt><dd>{formatDate(e.createdAt, t.locale)}</dd></div>}
                    <div className={s.factWide}><dt>{t('mcp.fact.next')}</dt><dd><p className={s.nextStep}>{nextStep(e)}</p></dd></div>
                  </dl>
                  <div className={s.actionsRow}>
                    <button type="button" className={s.secondary} disabled={!can.discover || busy !== null} onClick={() => void discover(e)}>
                      {busy === `snapshot:${e.id}` ? t('mcp.btn.discovering') : e.snapshot ? t('mcp.btn.rediscover') : t('mcp.btn.discover')}
                    </button>
                    {e.status === 'active'
                      ? <button type="button" className={s.secondary} disabled={!can.deactivate || busy !== null} onClick={() => void toggle(e, 'deactivate')}>{busy === `deactivate:${e.id}` ? t('mcp.btn.turningOff') : t('mcp.btn.off')}</button>
                      : <button type="button" className={s.secondary} disabled={!can.activate || !e.snapshot?.approved || busy !== null} onClick={() => void toggle(e, 'activate')}>{busy === `activate:${e.id}` ? t('mcp.btn.turningOn') : t('mcp.btn.on')}</button>}
                    <button type="button" className={s.secondary} disabled={!can.remove || busy !== null} onClick={(ev) => { deleteTrigger.current = ev.currentTarget; setDeleting(e); }}>{t('mcp.btn.remove')}</button>
                  </div>
                  {e.issue && <IssueBox issue={e.issue} t={t} />}
                  {e.snapshot && e.tools && (e.snapshot.approved ? (
                    <details className={s.toolsDetails}>
                      <summary>{t('mcp.btn.showTools', { count: e.tools.length })}</summary>
                      <McpToolReview key={`${e.snapshot.id}:approved`} tools={e.tools} approved serverStatus={e.status} lockedNote={lockedNote} />
                    </details>
                  ) : (
                    <McpToolReview
                      key={`${e.snapshot.id}:pending`}
                      tools={e.tools}
                      approved={false}
                      serverStatus={e.status}
                      onApprove={can.approve ? (p) => approve(e, p) : undefined}
                      lockedNote={lockedNote}
                    />
                  ))}
                </li>
              ))}
            </ul>
            </section>))}
          </>)}
        </>
      )}
      {!chatEnabled && <GapNote gap={BACKEND_GAPS.MCP_RUNTIME} label="Not enabled">Approved tools from an active MCP server can be used in Chat with <kbd>@</kbd> once your administrator switches on MCP in Chat. Every call is recorded in your organization&rsquo;s audit log. While it is switched off, the <kbd>@</kbd> menu shows these tools as &ldquo;Not available in chat yet&rdquo; with the reason.</GapNote>}
      {deleting && (
        <ConfirmDialog
          title={t('mcp.remove.title', { name: deleting.displayName })}
          confirmLabel={t('mcp.remove.confirm')}
          busyLabel={t('mcp.remove.busy')}
          onConfirm={can.remove ? () => remove(deleting) : undefined}
          onClose={closeDelete}
          onDone={closeDelete}
        >
          <p>{t('mcp.remove.body')}</p>
          <p className={s.url}>{deleting.url}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
