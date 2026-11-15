'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import s from './chat.module.css';

/** Same-origin JSON + non-simple header: what isSameOriginMutation() requires. */
export const MUTATION_HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;

export interface PublicModel { key: string; label: string; description: string; private: boolean; toolCalling: boolean }
export interface Thread { id: string; title: string; modelKey: string; updatedAt: string }
interface Message { id: string; role: 'user' | 'assistant' | 'tool'; content: string; status: 'complete' | 'error' | 'stopped'; mentions: { capability: string; provider: string }[]; capabilityKey: string | null }
interface Capability { capabilityKey: string; providerKey: string; providerName: string; description: string; permissionClass: string; state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available' }
type Live = { text: string; tools: { tool: string; ok?: boolean; code?: string }[] } | null;

const STATE_LABEL: Record<Capability['state'], string> = {
  connected: 'Connected',
  requires_connection: 'Connect first',
  disabled_by_policy: 'Turned off by your organization',
  not_available: 'Not available yet',
};
const TOOL_LABEL: Record<string, string> = { calendar_find_availability: 'Checking calendar availability' };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<T>;
}

export interface ChatWorkspaceProps {
  models: PublicModel[];
  /** Server-rendered first page of the person's chats; null means "load on the client". */
  initialThreads?: Thread[] | null;
}

export function ChatWorkspace({ models, initialThreads = null }: ChatWorkspaceProps) {
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
  const [error, setError] = useState<string | null>(null);
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
    setActiveId(id); setError(null); setMessages([]); setHistoryOpen(false);
    try {
      const d = await json<{ thread: Thread; messages: Message[] }>(await fetch(`/api/v1/chat/threads/${id}`, { cache: 'no-store' }));
      setMessages(d.messages);
      if (models.some((m) => m.key === d.thread.modelKey)) setModelKey(d.thread.modelKey);
    } catch { setError('This chat could not be opened.'); }
  }, [busy, models]);

  function newChat() {
    if (busy) return;
    setActiveId(null); setMessages([]); setAttached([]); setError(null); input.current?.focus();
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
    if (c.state !== 'connected') return;
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
    } catch { setError('A new chat could not be started.'); return; }
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
        throw new Error(body.error ?? 'The message could not be sent.');
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; tool?: string; ok?: boolean; code?: string; message?: Message };
          if (ev.type === 'user' && ev.message) setMessages((m) => [...m, ev.message!]);
          else if (ev.type === 'delta') setLive((l) => l && { ...l, text: l.text + (ev.text ?? '') });
          else if (ev.type === 'tool_start') setLive((l) => l && { ...l, tools: [...l.tools, { tool: ev.tool ?? '' }] });
          else if (ev.type === 'tool_result') setLive((l) => l && { ...l, tools: l.tools.map((t) => (t.tool === ev.tool && t.ok === undefined ? { ...t, ok: ev.ok, code: ev.code } : t)) });
          else if ((ev.type === 'done' || ev.type === 'error') && ev.message) setMessages((m) => [...m, ev.message!]);
          if (ev.type === 'error') setError(ev.code === 'MODEL_UNAVAILABLE' ? 'The model is not reachable right now.' : 'The answer could not be completed.');
        }
      }
      setAttached([]);
      setThreads((t) => (t ?? []).map((x) => (x.id === id ? { ...x, title: x.title === 'New chat' ? content.slice(0, 60) : x.title, updatedAt: new Date().toISOString() } : x)));
    } catch (e) {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'The message could not be sent.'); setDraft(content); }
    } finally { setLive(null); abort.current = null; }
  }

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
          {messages.map((m) => m.role === 'tool'
            ? <p key={m.id} className={m.status === 'error' ? s.toolFail : s.toolOk}>{m.content}</p>
            : <article key={m.id} className={m.role === 'user' ? s.user : s.assistant} aria-label={m.role === 'user' ? 'You' : 'TuGPT'}>
                {m.mentions.length > 0 && <div className={s.mentions}>{m.mentions.map((x) => <span key={x.capability + x.provider} className={s.chip}>@{x.provider} {x.capability}</span>)}</div>}
                {m.role === 'assistant' && m.content ? <Markdown text={m.content} /> : <div className={s.text}>{m.content || (m.status === 'stopped' ? 'Stopped.' : '')}</div>}
                {m.status !== 'complete' && <small className={s.status}>{m.status === 'stopped' ? 'Stopped' : 'Not completed'}</small>}
              </article>)}
          {live && (
            <article className={s.assistant} aria-label="TuGPT is answering">
              {live.tools.map((t, i) => <p key={i} className={t.ok === false ? s.toolFail : s.toolOk}>{TOOL_LABEL[t.tool] ?? t.tool}{t.ok === undefined ? '…' : t.ok ? ' · done' : ` · failed (${t.code ?? 'error'})`}</p>)}
              {live.text ? <Markdown text={live.text} /> : <div className={s.text}><span className={s.typing}>Thinking…</span></div>}
            </article>
          )}
        </div>

        {error && <p className={s.error} role="alert">{error}</p>}
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
          {showPicker && (
            <ul id={listId} role="listbox" aria-label="Apps you can use" className={s.picker}>
              {matches.length === 0 && <li className={s.muted} role="presentation">No matching apps. <Link href="/dashboard/connect">Open Connect</Link></li>}
              {matches.map((c, i) => (
                <li key={c.providerKey + c.capabilityKey} id={`${listId}-${i}`} role="option" aria-selected={i === picker.index} aria-disabled={c.state !== 'connected'}
                  className={`${s.option} ${i === picker.index ? s.optionActive : ''} ${c.state !== 'connected' ? s.optionOff : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); choose(c); }}>
                  <strong>{c.providerName}</strong><span>{c.description}</span><em>{STATE_LABEL[c.state]}</em>
                </li>
              ))}
            </ul>
          )}
          <p className={s.hint}>Enter to send · Shift+Enter for a new line · Answers can be wrong; check important facts.</p>
        </form>
      </section>
    </div>
  );
}
