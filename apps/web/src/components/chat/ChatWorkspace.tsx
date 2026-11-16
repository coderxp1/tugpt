'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { MentionPicker, type Capability } from './MentionPicker';
import { pickerBlock, requestProblem, toolLabel, toolProblem, turnProblem, type ChatProblem } from '@/lib/connect-ui/chat-errors';
import { readTurnStream, type TurnStreamEvent } from '@/lib/chat/stream';
import { parsePendingApproval, type PendingApproval } from '@/lib/chat/approval';
import s from './chat.module.css';

/** Same-origin JSON + non-simple header: what isSameOriginMutation() requires. */
export const MUTATION_HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;

export interface PublicModel { key: string; label: string; description: string; private: boolean; toolCalling: boolean }
export interface Thread { id: string; title: string; modelKey: string; updatedAt: string }
interface Message { id: string; role: 'user' | 'assistant' | 'tool'; content: string; status: 'complete' | 'error' | 'stopped'; mentions: { capability: string; provider: string }[]; capabilityKey: string | null }
type Live = { text: string; tools: { tool: string; provider?: string | null; ok?: boolean; code?: string }[] } | null;


async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<T>;
}

export interface ChatWorkspaceProps {
  models: PublicModel[];
  /** Server-rendered first page of the person's chats; null means "load on the client". */
  initialThreads?: Thread[] | null;
  /** Owner or admin of the active organization: may approve MCP calls (the backend checks again). */
  canApprove?: boolean;
}

interface ApprovalItem { approval: PendingApproval; afterId: string | null }
type RunResult = { ok: boolean; code?: string; message?: string };

export function ChatWorkspace({ models, initialThreads = null, canApprove = false }: ChatWorkspaceProps) {
  const [threads, setThreads] = useState<Thread[] | null>(initialThreads);
  const [threadsFailed, setThreadsFailed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null);
  const [modelKey, setModelKey] = useState(models[0]?.key ?? '');
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<Capability[]>([]);
  const [picker, setPicker] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 });
  const [live, setLive] = useState<Live>(null);
  const [error, setError] = useState<ChatProblem | null>(null);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const pendingApprovals = useRef<PendingApproval[]>([]);
  const fail = (text: string) => setError({ text, connect: false });
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const listId = useId();
  const model = models.find((m) => m.key === modelKey) ?? null;
  const busy = live !== null;

  // State is only set when the request settles, never synchronously in the effect.
  const fetchThreads = useCallback(() => fetch('/api/v1/chat/threads', { cache: 'no-store' })
    .then((r) => json<{ threads: Thread[] }>(r))
    .then((d) => { setThreads(d.threads); setThreadsFailed(false); })
    .catch(() => { setThreads([]); setThreadsFailed(true); }), []);
  function retryThreads() { setThreadsFailed(false); setThreads(null); void fetchThreads(); }

  const needThreads = initialThreads === null;
  useEffect(() => {
    if (needThreads) void fetchThreads();
    fetch('/api/v1/chat/capabilities', { cache: 'no-store' }).then((r) => json<{ capabilities: Capability[] }>(r))
      .then((d) => setCapabilities(d.capabilities)).catch(() => setCapabilities([]));
  }, [needThreads, fetchThreads]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, live]);

  const open = useCallback(async (id: string) => {
    if (busy) return;
    setActiveId(id); setError(null); setMessages([]); setApprovals([]); setHistoryOpen(false);
    try {
      const d = await json<{ thread: Thread; messages: Message[] }>(await fetch(`/api/v1/chat/threads/${id}`, { cache: 'no-store' }));
      setMessages(d.messages);
      if (models.some((m) => m.key === d.thread.modelKey)) setModelKey(d.thread.modelKey);
    } catch { setError({ text: 'This chat could not be opened.', connect: false }); }
  }, [busy, models]);

  function newChat() {
    if (busy) return;
    setActiveId(null); setMessages([]); setApprovals([]); setAttached([]); setError(null); input.current?.focus();
  }

  const matches = useMemo(() => {
    const q = picker.query.toLowerCase();
    return (capabilities ?? []).filter((c) => !attached.some((a) => a.capabilityKey === c.capabilityKey && a.providerKey === c.providerKey))
      .filter((c) => !q || `${c.providerName} ${c.description}`.toLowerCase().includes(q));
  }, [capabilities, picker.query, attached]);

  function onDraft(value: string) {
    setDraft(value);
    const el = input.current; const caret = el?.selectionStart ?? value.length;
    const m = /(^|\s)@([\w\- ]{0,30})$/.exec(value.slice(0, caret));
    setPicker(m ? { open: true, query: m[2], index: 0 } : { open: false, query: '', index: 0 });
  }

  function choose(c: Capability) {
    if (pickerBlock(c, model?.toolCalling ?? false) !== null) return;
    const caret = input.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/(^|\s)@[\w\- ]{0,30}$/, '$1');
    setDraft(before + draft.slice(caret));
    setAttached((a) => [...a, c]);
    setPicker({ open: false, query: '', index: 0 });
    input.current?.focus();
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (picker.open && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker((p) => ({ ...p, index: (p.index + 1) % matches.length })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker((p) => ({ ...p, index: (p.index - 1 + matches.length) % matches.length })); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[picker.index]); return; }
    }
    if (picker.open && e.key === 'Escape') { e.preventDefault(); setPicker({ open: false, query: '', index: 0 }); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  }

  /** Approval cards collected during a turn are placed after the answer they belong to. */
  function flushApprovals(afterId: string | null) {
    const list = pendingApprovals.current;
    pendingApprovals.current = [];
    if (list.length === 0) return;
    setApprovals((a) => [...a, ...list.filter((p) => !a.some((x) => x.approval.callId === p.callId && x.approval.threadId === p.threadId)).map((approval) => ({ approval, afterId }))]);
  }

  function handleEvent(ev: TurnStreamEvent) {
    const message = ev.message as Message | undefined;
    if (ev.type === 'user' && message) setMessages((m) => [...m, message]);
    else if (ev.type === 'delta') setLive((l) => l && { ...l, text: l.text + (ev.text ?? '') });
    else if (ev.type === 'tool_start') setLive((l) => l && { ...l, tools: [...l.tools, { tool: ev.tool ?? '', provider: ev.provider }] });
    else if (ev.type === 'tool_result') setLive((l) => l && { ...l, tools: l.tools.map((t) => (t.tool === ev.tool && t.ok === undefined ? { ...t, ok: ev.ok === true, code: ev.code } : t)) });
    else if (ev.type === 'approval_required') {
      // Malformed payloads are dropped: a card is only shown for a well-formed, server-built request.
      const p = parsePendingApproval(ev.approval);
      if (p) pendingApprovals.current.push(p);
    } else if ((ev.type === 'done' || ev.type === 'error') && message) { setMessages((m) => [...m, message]); flushApprovals(message.id); }
    if (ev.type === 'error') fail(turnProblem(ev.code));
  }

  /** Runs one approved MCP call through the server (which claims the approval) and streams the answer. */
  async function runApproved(p: PendingApproval): Promise<RunResult> {
    if (busy || !model || p.threadId !== activeId) return { ok: false, code: 'INTERRUPTED' };
    setError(null);
    const controller = new AbortController(); abort.current = controller;
    setLive({ text: '', tools: [] });
    let result: RunResult = { ok: false, code: 'INTERRUPTED' };
    try {
      const res = await fetch(`/api/v1/chat/threads/${p.threadId}/approved-call`, {
        method: 'POST', signal: controller.signal, headers: MUTATION_HEADERS,
        body: JSON.stringify({
          callId: p.callId, modelKey: model.key, connectionId: p.endpointId, capability: p.capability,
          arguments: p.arguments, argumentsSha256: p.argumentsSha256, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok || !res.body) {
        // Refused before anything ran (gate closed, changed arguments, ...). The card explains it in
        // context; the page-level "remove the app" message does not apply to an approved call.
        const body = await res.json().catch(() => ({})) as { error?: unknown };
        const reason = typeof body.error === 'string' && body.error.length <= 200 ? body.error.replace(/\.$/, '') : `the server answered ${res.status}`;
        return { ok: false, code: 'REQUEST_REFUSED', message: reason };
      }
      const summary = await readTurnStream(res.body, (ev) => {
        if (ev.type === 'tool_result') result = { ok: ev.ok === true, ...(ev.code ? { code: ev.code } : {}) };
        handleEvent(ev);
      });
      if (summary.terminal === null && !controller.signal.aborted) fail(turnProblem('INTERRUPTED'));
      return result;
    } catch {
      if (!controller.signal.aborted) fail('The approved call could not be sent.');
      return result;
    } finally { flushApprovals(null); setLive(null); abort.current = null; }
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy || !model) return;
    setError(null);
    let id = activeId;
    try {
      if (!id) {
        const d = await json<{ thread: Thread }>(await fetch('/api/v1/chat/threads', {
          method: 'POST', headers: MUTATION_HEADERS, body: JSON.stringify({ modelKey: model.key }),
        }));
        id = d.thread.id; setActiveId(id); setThreads((t) => [d.thread, ...(t ?? [])]);
      }
    } catch { fail('A new chat could not be started.'); return; }
    const controller = new AbortController(); abort.current = controller;
    setDraft(''); setLive({ text: '', tools: [] });
    const mentions = attached.map((c) => ({ capability: c.capabilityKey, provider: c.providerKey }));
    try {
      const res = await fetch(`/api/v1/chat/threads/${id}/messages`, {
        method: 'POST', signal: controller.signal, headers: MUTATION_HEADERS,
        body: JSON.stringify({ content, modelKey: model.key, mentions, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(requestProblem(body.error)); setDraft(content); return;
      }
      const summary = await readTurnStream(res.body, handleEvent);
      // A stream that ends without done/error was cut off; never present it as a finished answer.
      if (summary.terminal === null && !controller.signal.aborted) fail(turnProblem('INTERRUPTED'));
      setAttached([]);
      setThreads((t) => (t ?? []).map((x) => (x.id === id ? { ...x, title: x.title === 'New chat' ? content.slice(0, 60) : x.title, updatedAt: new Date().toISOString() } : x)));
    } catch (e) {
      if (!controller.signal.aborted) { fail(e instanceof Error && e.message ? e.message : 'The message could not be sent.'); setDraft(content); }
    } finally { flushApprovals(null); setLive(null); abort.current = null; }
  }

  const card = (it: ApprovalItem) => (
    <ApprovalCard key={`${it.approval.threadId}:${it.approval.callId}`} approval={it.approval} canApprove={canApprove} busy={busy} onRun={runApproved} />
  );
  const placed = new Set(messages.map((m) => m.id));

  const showPicker = picker.open && capabilities !== null;
  const activeOption = showPicker && matches[picker.index] ? `${listId}-${picker.index}` : undefined;

  return (
    <div className={s.chat}>
      <aside className={`${s.threads} ${historyOpen ? s.threadsOpen : ''}`} aria-label="Your chats">
        <div className={s.threadsHead}>
          <button type="button" className={s.newChat} onClick={() => { setHistoryOpen(false); newChat(); }} disabled={busy}>New chat</button>
          <button type="button" className={s.historyToggle} aria-expanded={historyOpen} aria-controls="chat-history" onClick={() => setHistoryOpen((o) => !o)}>
            {historyOpen ? 'Hide chats' : `Your chats${threads && threads.length ? ` (${threads.length})` : ''}`}
          </button>
        </div>
        <div id="chat-history" className={s.history}>
          <p className={s.private}>Only you can see your chats.</p>
          {threads === null ? <ul className={s.threadList} aria-busy="true" aria-label="Loading your chats">{[0, 1, 2].map((i) => <li key={i} className={s.skeleton} />)}<li className={s.sr} role="status">Loading your chats…</li></ul> :
            threadsFailed ? <div className={s.loadError} role="alert"><p>Your chats could not be loaded.</p><button type="button" onClick={retryThreads}>Try again</button></div> :
            threads.length === 0 ? <p className={s.muted}>No chats yet. Your conversations will appear here.</p> :
            <ul className={s.threadList}>{threads.map((t) => (
              <li key={t.id}><button type="button" onClick={() => void open(t.id)} aria-current={t.id === activeId ? 'true' : undefined} className={t.id === activeId ? s.threadActive : s.thread} title={t.title}>{t.title}</button></li>
            ))}</ul>}
        </div>
      </aside>

      <section className={s.main} aria-label="Conversation">
        <header className={s.bar}>
          <label className={s.modelLabel}>
            <span>Model</span>
            <select value={modelKey} onChange={(e) => setModelKey(e.target.value)} disabled={busy || models.length === 0}>
              {models.map((m) => <option key={m.key} value={m.key}>{m.label}{m.private ? ' · private' : ''}</option>)}
            </select>
          </label>
          {model && <span className={s.modelNote}>{model.description}</span>}
        </header>

        <div ref={log} className={s.log} role="log" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
          {messages.length === 0 && !live && (
            <div className={s.empty}>
              <h1>What are we working on?</h1>
              <p>Ask anything. Type <kbd>@</kbd> to use a connected app, for example your Google Calendar.</p>
            </div>
          )}
          {messages.map((m) => <Fragment key={m.id}>{m.role === 'tool'
            ? <p className={m.status === 'error' ? s.toolFail : s.toolOk}>{m.content}</p>
            : <article className={m.role === 'user' ? s.user : s.assistant} aria-label={m.role === 'user' ? 'You' : 'TuGPT'}>
                {m.mentions.length > 0 && <div className={s.mentions}>{m.mentions.map((x) => <span key={x.capability + x.provider} className={s.chip}>@{x.provider} {x.capability}</span>)}</div>}
                {m.role === 'assistant' && m.content ? <Markdown text={m.content} /> : <div className={s.text}>{m.content || (m.status === 'stopped' ? 'Stopped.' : '')}</div>}
                {m.status !== 'complete' && <small className={s.status}>{m.status === 'stopped' ? 'Stopped' : 'Not completed'}</small>}
              </article>}
            {approvals.filter((a) => a.afterId === m.id).map(card)}</Fragment>)}
          {approvals.filter((a) => a.afterId === null || !placed.has(a.afterId)).map(card)}
          {live && (
            <article className={s.assistant} aria-label="TuGPT is answering">
              {live.tools.map((t, i) => <p key={i} className={t.ok === false ? s.toolFail : s.toolOk}>{toolLabel(t.tool, t.provider)}{t.ok === undefined ? '…' : t.ok ? ' · done' : <> · {toolProblem(t.code).text}{toolProblem(t.code).connect && <> <Link href="/dashboard/connect">Open Connect</Link></>}</>}</p>)}
              {live.text ? <Markdown text={live.text} /> : <div className={s.text}><span className={s.typing}>Thinking…</span></div>}
            </article>
          )}
        </div>

        {error && <p className={s.error} role="alert">{error.text}{error.connect && <> <Link href="/dashboard/connect">Open Connect</Link></>}</p>}
        {models.length === 0 && <p className={s.error} role="alert">No model is configured for this workspace yet. An administrator can add one.</p>}

        <form className={s.composer} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {attached.length > 0 && <div className={s.mentions} aria-label="Attached apps">{attached.map((c) => (
            <span key={c.providerKey + c.capabilityKey} className={s.chip}>@{c.providerName} · {c.description}
              <button type="button" aria-label={`Remove ${c.providerName}`} onClick={() => setAttached((a) => a.filter((x) => x !== c))}>×</button></span>
          ))}</div>}
          <div className={s.inputRow}>
            <label htmlFor="chat-input" className={s.sr}>Message</label>
            <textarea id="chat-input" ref={input} value={draft} rows={2} maxLength={8000} placeholder="Message TuGPT — type @ to use an app"
              onChange={(e) => onDraft(e.target.value)} onKeyDown={onKey} disabled={models.length === 0}
              role="combobox" aria-expanded={showPicker} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeOption} />
            {busy
              ? <button type="button" className={s.stop} onClick={() => abort.current?.abort()}>Stop</button>
              : <button type="submit" className={s.send} disabled={!draft.trim() || !model}>Send</button>}
          </div>
          {showPicker && <MentionPicker id={listId} matches={matches} activeIndex={picker.index} modelCanUseTools={model?.toolCalling ?? false} onChoose={choose} />}
          <p className={s.hint}>Enter to send · Shift+Enter for a new line · Answers can be wrong; check important facts.</p>
        </form>
      </section>
    </div>
  );
}
