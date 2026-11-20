'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BACKEND_GAPS, present, type RouteAvailability } from '@/lib/connect-ui/contract';
import { ENDPOINT_STATUS_TEXT, PERMISSION_LEVELS, PERMISSION_TEXT, mcpApi, mcpProblem, newIdempotencyKey, SNAPSHOT_RETRY_SAME_KEY, validateEndpointInput, type McpEndpoint, type McpTool, type PermissionLevel, type SnapshotState } from '@/lib/connect-ui/mcp';
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

interface Row extends McpEndpoint { snapshot?: SnapshotState; tools?: McpTool[]; problem?: string }

const GROUP_ORDER = ['active', 'pending', 'disabled'] as const;
const GROUP_TITLE: Record<(typeof GROUP_ORDER)[number], string> = { active: 'Active', pending: 'Not switched on yet', disabled: 'Turned off' };

/** "3 tools: 2 Read only, 1 Makes changes", from tools the backend returned in this visit only. */
export function permissionSummary(tools: readonly McpTool[]): string {
  const parts = PERMISSION_LEVELS.map((l) => [l, tools.filter((t) => t.permissionClass === l).length] as const).filter(([, n]) => n > 0)
    .map(([l, n]) => `${n} ${PERMISSION_TEXT[l].label}`);
  return `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/**
 * Customer-run MCP servers. The list comes from GET /mcp/endpoints; tools and
 * their permission classes from GET /mcp/snapshots/{id}/tools. Nothing is shown
 * as active, approved or connected unless a backend response said so.
 */
export function McpPanel({ canManage, routes, enabled, chatEnabled = false, fetcher }: McpPanelProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [url, setUrl] = useState(''); const [name, setName] = useState('');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  // M9: Idempotency-Key of a snapshot attempt whose outcome may still be pending, per endpoint; reused on retry.
  const pendingSnapshotKey = useRef(new Map<string, string>());

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

  /** Applies a list response; keeps snapshot facts learnt in this session for endpoints that still exist. */
  const apply = useCallback((r: Awaited<ReturnType<typeof mcpApi.list>>) => {
    if (!r.ok) { setLoadProblem(mcpProblem(r)); setRows((prev) => prev ?? []); return; }
    setLoadProblem(null);
    setRows((prev) => r.data.map((e) => {
      const old = prev?.find((p) => p.id === e.id);
      return { ...e, snapshot: old?.snapshot, tools: old?.tools };
    }));
  }, []);
  const reload = useCallback(async () => { apply(await mcpApi.list(fetcher)); }, [apply, fetcher]);

  useEffect(() => {
    if (!canList) return;
    let live = true;
    void mcpApi.list(fetcher).then((r) => { if (live) apply(r); });
    return () => { live = false; };
  }, [canList, apply, fetcher]);

  async function register(ev: React.FormEvent) {
    ev.preventDefault();
    if (!can.register) return;
    const invalid = validateEndpointInput(url, name);
    if (invalid) { setFormProblem(invalid); return; }
    setBusy('register'); setFormProblem(null);
    const r = await mcpApi.register(url, name, fetcher);
    setBusy(null);
    if (!r.ok) { setFormProblem(mcpProblem(r)); return; }
    setUrl(''); setName('');
    await reload();
  }

  async function loadTools(e: Row, snapshot: SnapshotState) {
    const t = await mcpApi.tools(snapshot.id, fetcher);
    if (t.ok) patch(e.id, { snapshot, tools: t.data, problem: undefined });
    else patch(e.id, { snapshot, tools: undefined, problem: `The tools could not be read. ${mcpProblem(t)}` });
  }

  async function discover(e: Row) {
    if (!can.discover) return;
    setBusy(`snapshot:${e.id}`); patch(e.id, { problem: undefined });
    const key = pendingSnapshotKey.current.get(e.id) ?? newIdempotencyKey();
    pendingSnapshotKey.current.set(e.id, key);
    const r = await mcpApi.snapshot(e.id, fetcher, key);
    // Keep the key only while a retry could still return the original; otherwise the next click starts afresh.
    if (r.ok || !SNAPSHOT_RETRY_SAME_KEY.has(r.code)) pendingSnapshotKey.current.delete(e.id);
    if (r.ok) await loadTools(e, { id: r.data.snapshotId, toolCount: r.data.toolCount, approved: false });
    else patch(e.id, { problem: mcpProblem(r) });
    setBusy(null);
  }

  async function approve(e: Row, permissions: Record<string, PermissionLevel>): Promise<string | null> {
    if (!e.snapshot || !can.approve) return 'Approving is switched off.';
    const r = await mcpApi.approve(e.snapshot.id, permissions, fetcher);
    if (r.ok || r.code === 'ALREADY_APPROVED') {
      await loadTools(e, { ...e.snapshot, approved: true });
      return null;
    }
    return mcpProblem(r);
  }

  async function toggle(e: Row, action: 'activate' | 'deactivate') {
    if (action === 'activate' ? !can.activate || !e.snapshot?.approved : !can.deactivate) return;
    setBusy(`${action}:${e.id}`); patch(e.id, { problem: undefined });
    const r = action === 'activate' ? await mcpApi.activate(e.id, fetcher) : await mcpApi.deactivate(e.id, fetcher);
    // Re-read first so the shown status is the backend's; then attach any error to the fresh row.
    await reload();
    if (!r.ok) patch(e.id, { problem: mcpProblem(r) });
    setBusy(null);
  }

  async function remove(e: Row): Promise<string | null> {
    const r = await mcpApi.remove(e.id, fetcher);
    if (!r.ok) return mcpProblem(r);
    if (r.data.deleted !== true) return 'TuGPT did not confirm the removal. The list below was checked again.';
    await reload();
    return null;
  }

  const closeDelete = () => { setDeleting(null); deleteTrigger.current?.focus(); };
  const lockedNote = !enabled
    ? <p className={s.muted}>Approving tools is switched off for your organization right now.</p>
    : <p className={s.muted}>Approving tools is not available yet.</p>;

  return (
    <section className={s.section} aria-labelledby="mcp-title">
      <h2 id="mcp-title">Your own tools (MCP)</h2>
      <p className={s.lead}>Connect a tool server your organization runs (Model Context Protocol). TuGPT reads the tools it offers; an owner or admin reviews each one and decides what it may do before anything is switched on.</p>
      <ol className={s.steps} aria-label="How it works">
        <li><strong>Add</strong> the server&rsquo;s https address.</li>
        <li><strong>Discover</strong> the tools it offers.</li>
        <li><strong>Review</strong> each tool: read only, or may make changes (always asks first).</li>
        <li><strong>Switch on</strong> the server.</li>
      </ol>
      <p className={s.muted} data-testid="mcp-chat-status"><strong>In Chat:</strong> {chatEnabled ? 'tools of active servers can be used with @ in Chat. Tools that make changes ask for approval each time.' : 'not usable yet. Chat does not call MCP tools until this is switched on for your organization, even when a server is active.'}</p>
      {!enabled && <GapNote gap={BACKEND_GAPS.EGRESS} label="Not enabled">Adding servers, discovering tools, approving and switching on are not enabled for your organization yet. You can still see, turn off and remove servers that already exist.</GapNote>}

      {!canManage ? <p className={s.muted}>Only an organization owner or admin can see and manage MCP servers.</p> : (
        <>
          <form className={s.form} onSubmit={(e) => void register(e)} noValidate>
            <fieldset disabled={!can.register || busy === 'register'}>
              <legend className={s.sr}>Add an MCP server</legend>
              <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} placeholder="Support knowledge base" /></label>
              <label>Server address<input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" autoComplete="off" placeholder="https://mcp.example.com/sse" aria-describedby="mcp-url-help" /></label>
              <small id="mcp-url-help">https only. Never put passwords or tokens in the address.</small>
              <button type="submit" className={s.primary} disabled={!can.register || busy === 'register'}>{busy === 'register' ? 'Adding…' : 'Add server'}</button>
            </fieldset>
            {formProblem && <p className={s.error} role="alert">{formProblem}</p>}
          </form>

          {!canList && <p className={s.muted} role="note">The server list is not available yet.</p>}
          {canList && rows === null && <p className={s.muted} role="status">Loading servers…</p>}
          {loadProblem && (
            <div className={s.actionsRow}>
              <p className={s.error} role="alert">The server list could not be loaded. {loadProblem}</p>
              <button type="button" className={s.secondary} onClick={() => void reload()}>Try again</button>
            </div>
          )}
          {rows !== null && rows.length === 0 && !loadProblem && <p className={s.muted}>No MCP servers yet.</p>}
          {rows !== null && rows.length > 0 && (<>
            <div className={s.mcpSummary} data-testid="mcp-summary" role="group" aria-label="MCP servers at a glance">
              {GROUP_ORDER.map((g) => <p key={g}><strong>{rows.filter((r) => r.status === g).length}</strong><span>{GROUP_TITLE[g]}</span></p>)}
              <p><strong>{chatEnabled ? 'Yes' : 'Not yet'}</strong><span>Usable in Chat</span></p>
            </div>
            {enabled && <p className={s.muted}>&ldquo;Switch on&rdquo; unlocks after you discover a server&rsquo;s tools and approve them. TuGPT checks the list again when you switch it on.</p>}
            {GROUP_ORDER.filter((g) => rows.some((r) => r.status === g)).map((g) => (
            <section key={g} className={s.mcpGroup} aria-labelledby={`mcp-group-${g}`}>
            <h3 id={`mcp-group-${g}`}>{GROUP_TITLE[g]} <span className={s.count}>({rows.filter((r) => r.status === g).length})</span></h3>
            <ul className={s.endpoints} aria-label={`${GROUP_TITLE[g]} MCP servers`}>
              {rows.filter((r) => r.status === g).map((e) => {
                const next = e.status === 'active' ? (chatEnabled ? 'Available in Chat with @.' : 'Active, but not usable in Chat yet.') : e.snapshot?.approved ? 'Tools reviewed. Switch the server on to make them available.' : e.snapshot ? `${e.snapshot.toolCount} ${e.snapshot.toolCount === 1 ? 'tool' : 'tools'} found. Review them below.` : enabled ? 'Next step: discover its tools.' : 'Adding tools is not enabled yet. You can turn this server off or remove it.';
                const changes = e.tools?.some((t) => t.permissionClass !== 'read');
                return (
                <li key={e.id} className={s.card}>
                  <div className={s.endpointHead}>
                    <h4>{e.displayName}</h4>
                    <span className={`${s.badge} ${e.status === 'active' ? s.ok : e.status === 'pending' ? s.idle : s.off}`}>{ENDPOINT_STATUS_TEXT[e.status]}</span>
                  </div>
                  <p className={s.url}>{e.url}</p>
                  <dl className={s.mcpFacts}>
                    <div><dt>Tools</dt><dd>{e.tools ? permissionSummary(e.tools) : 'Not checked during this visit. Use \u201cDiscover tools\u201d to see them.'}</dd></div>
                    <div><dt>Approval</dt><dd>{e.tools ? changes ? 'Tools that can make changes are blocked on every use until an owner or admin approves that exact call.' : 'Read-only tools. No approval per use is needed.' : 'Shown after the tools are discovered.'}</dd></div>
                    <div><dt>In Chat</dt><dd>{chatEnabled ? e.status === 'active' ? 'Usable with @' : 'Only after it is switched on' : 'Not usable yet'}</dd></div>
                    <div><dt>Next step</dt><dd><p className={s.nextStep}>{next}</p></dd></div>
                  </dl>
                  <div className={s.actionsRow}>
                    <button type="button" className={s.secondary} disabled={!can.discover || busy !== null} onClick={() => void discover(e)}>
                      {busy === `snapshot:${e.id}` ? 'Discovering…' : e.snapshot ? 'Discover again' : 'Discover tools'}
                    </button>
                    {e.status === 'active'
                      ? <button type="button" className={s.secondary} disabled={!can.deactivate || busy !== null} onClick={() => void toggle(e, 'deactivate')}>{busy === `deactivate:${e.id}` ? 'Turning off…' : 'Turn off'}</button>
                      : <button type="button" className={s.secondary} disabled={!can.activate || !e.snapshot?.approved || busy !== null} onClick={() => void toggle(e, 'activate')}>{busy === `activate:${e.id}` ? 'Switching on…' : 'Switch on'}</button>}
                    <button type="button" className={s.secondary} disabled={!can.remove || busy !== null} onClick={(ev) => { deleteTrigger.current = ev.currentTarget; setDeleting(e); }}>Remove…</button>
                  </div>
                  {e.snapshot && e.tools && (
                    <McpToolReview
                      key={`${e.snapshot.id}:${e.snapshot.approved}`}
                      tools={e.tools}
                      approved={e.snapshot.approved}
                      onApprove={can.approve ? (p) => approve(e, p) : undefined}
                      lockedNote={lockedNote}
                    />
                  )}
                  {e.problem && <p className={s.error} role="alert">{e.problem}</p>}
                </li>);
              })}
            </ul>
            </section>))}
          </>)}
          <GapNote gap={BACKEND_GAPS.MCP_STATE} label="Good to know">After you reload this page, a review starts again from &ldquo;Discover tools&rdquo;.</GapNote>
        </>
      )}
      {!chatEnabled && <GapNote gap={BACKEND_GAPS.MCP_RUNTIME} label="Not enabled">Active servers appear in the Chat <kbd>@</kbd> menu as &ldquo;Not available in chat yet&rdquo;. Chat does not call them until MCP tools in Chat are switched on for your organization.</GapNote>}
      {deleting && (
        <ConfirmDialog
          title={`Remove ${deleting.displayName}?`}
          confirmLabel="Remove server"
          busyLabel="Removing…"
          onConfirm={can.remove ? () => remove(deleting) : undefined}
          onClose={closeDelete}
          onDone={closeDelete}
        >
          <p>TuGPT deletes this server together with its discovered tool lists and their reviewed permission levels. This cannot be undone.</p>
          <p className={s.url}>{deleting.url}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
