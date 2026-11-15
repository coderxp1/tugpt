'use client';

import { useState } from 'react';
import { BACKEND_GAPS, usable, type RouteAvailability } from '@/lib/connect-ui/contract';
import { mcpApi, mcpProblem, validateEndpointInput, type McpEndpoint } from '@/lib/connect-ui/mcp';
import { GapNote } from './GapNote';
import { McpToolReview } from './McpToolReview';
import s from './connect.module.css';

export interface McpPanelProps { canManage: boolean; routes: RouteAvailability }

const STATUS: Record<string, string> = { pending: 'Not active', active: 'Active', disabled: 'Turned off' };

/** Customer-run MCP servers: register, discover, review, activate. Every state shown comes from a real response. */
export function McpPanel({ canManage, routes }: McpPanelProps) {
  const [endpoints, setEndpoints] = useState<McpEndpoint[]>([]);
  const [url, setUrl] = useState(''); const [name, setName] = useState('');
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const patch = (id: string, p: Partial<McpEndpoint>) => setEndpoints((all) => all.map((e) => (e.id === id ? { ...e, ...p } : e)));

  async function register(ev: React.FormEvent) {
    ev.preventDefault();
    const invalid = validateEndpointInput(url, name);
    if (invalid) { setFormProblem(invalid); return; }
    setBusy('register'); setFormProblem(null);
    const r = await mcpApi.register(url, name);
    setBusy(null);
    if (!r.ok) { setFormProblem(mcpProblem(r)); return; }
    setEndpoints((all) => [{ ...r.data.endpoint }, ...all]); setUrl(''); setName('');
  }

  async function run(e: McpEndpoint, action: 'snapshot' | 'activate' | 'deactivate') {
    setBusy(`${action}:${e.id}`); patch(e.id, { problem: undefined });
    if (action === 'snapshot') {
      const r = await mcpApi.snapshot(e.id);
      if (r.ok) patch(e.id, { snapshot: { id: r.data.snapshotId, toolCount: r.data.toolCount, approved: false } }); else patch(e.id, { problem: mcpProblem(r) });
    } else {
      const r = action === 'activate' ? await mcpApi.activate(e.id) : await mcpApi.deactivate(e.id);
      if (r.ok) patch(e.id, { status: r.data.status }); else patch(e.id, { problem: mcpProblem(r) });
    }
    setBusy(null);
  }

  const registerOpen = usable(routes.mcpRegister);
  return (
    <section className={s.section} aria-labelledby="mcp-title">
      <h2 id="mcp-title">Your own tools (MCP)</h2>
      <p className={s.lead}>Connect a Model Context Protocol server your organization runs. TuGPT reads the tools it offers; an admin reviews each one and sets its permission level before anything can be switched on.</p>
      {!canManage ? <p className={s.muted}>Only an organization owner or admin can add and manage MCP servers.</p> : (
        <form className={s.form} onSubmit={(e) => void register(e)} noValidate>
          <fieldset disabled={!registerOpen || busy === 'register'}>
            <legend className={s.sr}>Add an MCP server</legend>
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={80} placeholder="Support knowledge base" /></label>
            <label>Server address<input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" autoComplete="off" placeholder="https://mcp.example.com/sse" aria-describedby="mcp-url-help" /></label>
            <small id="mcp-url-help">https only. Never put passwords or tokens in the address.</small>
            <button type="submit" className={s.primary} disabled={!registerOpen || busy === 'register'}>{busy === 'register' ? 'Adding…' : 'Add server'}</button>
          </fieldset>
          {!registerOpen && <p className={s.muted} role="note">Adding servers is not part of this build yet. It needs <code>POST /api/v1/connect/mcp/endpoints</code>.</p>}
          {formProblem && <p className={s.error} role="alert">{formProblem}</p>}
        </form>
      )}
      <GapNote gap={BACKEND_GAPS.B1}>Servers added earlier are not listed. Servers you add now show below until you leave or reload this page.</GapNote>
      {endpoints.length > 0 && (
        <ul className={s.endpoints} aria-label="Servers added in this session">
          {endpoints.map((e) => (
            <li key={e.id} className={s.card}>
              <div className={s.endpointHead}><h3>{e.displayName}</h3><span className={`${s.badge} ${e.status === 'active' ? s.ok : s.off}`}>{STATUS[e.status] ?? e.status}</span></div>
              <p className={s.url}>{e.url}</p>
              <div className={s.actionsRow}>
                <button type="button" className={s.secondary} disabled={!usable(routes.mcpSnapshot) || busy !== null} onClick={() => void run(e, 'snapshot')}>{e.snapshot ? 'Discover again' : 'Discover tools'}</button>
                {e.status === 'active'
                  ? <button type="button" className={s.secondary} disabled={!usable(routes.mcpDeactivate) || busy !== null} onClick={() => void run(e, 'deactivate')}>Turn off</button>
                  : <button type="button" className={s.secondary} disabled={!usable(routes.mcpActivate) || busy !== null} onClick={() => void run(e, 'activate')}>Activate</button>}
              </div>
              {e.snapshot && <McpToolReview tools={null} toolCount={e.snapshot.toolCount} />}
              {e.problem && <p className={s.error} role="alert">{e.problem}</p>}
            </li>
          ))}
        </ul>
      )}
      <GapNote gap={BACKEND_GAPS.B4}>Approved MCP tools do not appear in the Chat <kbd>@</kbd> menu yet, and chat cannot call them ({BACKEND_GAPS.B3.id}).</GapNote>
    </section>
  );
}
