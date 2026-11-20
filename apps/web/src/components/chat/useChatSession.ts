'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { saveChatRecovery, loadChatRecovery, clearChatRecovery, hasRecoveredAnswer, type ChatRecovery } from '@/lib/workspace/chat-recovery';
import { uploadSafely } from '@/lib/workspace/file-upload';
import { customerModels } from '@/lib/workspace/assistant-capabilities';
import { usePathname, useSearchParams } from 'next/navigation';
import type { Capability } from './MentionPicker';
import type { ApprovalItem, Live, Message, PublicModel, RunResult, Thread } from './types';
import { pickerBlock, requestProblem, turnProblem, type ChatProblem } from '@/lib/connect-ui/chat-errors';
import { readTurnStream, type TurnStreamEvent } from '@/lib/chat/stream';
import { parsePendingApproval, type PendingApproval } from '@/lib/chat/approval';
import { threadHref, threadIdFromPath } from '@/lib/workspace/routes';
import { useThreads } from '@/components/workspace/ThreadsProvider';
import { useT } from '@/i18n/provider';
import { agentsApiAvailable } from '@/lib/workspace/agents';
import { createAgentsClient } from '@/lib/workspace/custom-agents';
import { parseAgentIdentity, parseAgentCitations, type AgentCitation } from '@/lib/workspace/agent-events';
import { findStarter } from '@/lib/workspace/starters';
import {
  composeContent, MAX_FILES, MESSAGE_LIMIT, refusalFor, safeName, type AttachmentRefusal, type TextAttachment,
} from '@/lib/workspace/attachments';
import { mediaTypeFor, routeFile, MAX_UPLOADS, UPLOAD_MAX_BYTES, formatBytes, type UploadRefusal } from '@/lib/workspace/uploads';
import { workspaceApi } from '@/lib/workspace/service';

/** Same-origin JSON + non-simple header: what isSameOriginMutation() requires. */
export const MUTATION_HEADERS = { 'content-type': 'application/json', 'x-tugpt-csrf': '1' } as const;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<T>;
}
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** File.text() is missing in some older browsers (and jsdom); FileReader works everywhere. */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

/**
 * Everything one chat needs: the open thread, its messages, the live answer, @ apps, approvals.
 * Extracted unchanged in behaviour from the former ChatWorkspace; what is new is that the address
 * bar selects the chat (/workspace = new chat, /workspace/c/<id> = that chat), so links in the
 * sidebar, Back/Forward and bookmarks all work. Starting a chat rewrites the address in place
 * (history.replaceState) so the answer that is streaming is not interrupted.
 */
/** A document on its way to (or stored in) the Files API. */
export interface UploadItem {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly status: 'uploading' | 'ready' | 'failed';
  readonly fileId: string | null;
  readonly percent?: number | null;
  /** The chat it is linked to, once linked. */
  readonly attachedTo: string | null;
  readonly message: string | null;
}

export function useChatSession(configured: PublicModel[], uploadScope?: string) {
  const models = useMemo(() => customerModels(configured), [configured]);
  const { add, touch, setBusy } = useThreads();
  const t = useT();
  const requestedAgent = useSearchParams()?.get('agent') ?? null;
  const [selectedAgent, setSelectedAgent] = useState<{ id: string; name: string } | null>(null);
  const [agentFailed, setAgentFailed] = useState<string | null>(null);
  const [turnAgent, setTurnAgent] = useState<{ id: string; name: string } | null>(null);
  const [savedAgent, setSavedAgent] = useState<{ threadId: string; agentId: string | null | undefined; name?: string; unavailable?: boolean } | null>(null);
  const [toolsUnavailable, setToolsUnavailable] = useState(false);
  const citationState = useRef<{ citations: AgentCitation[]; knowledgeUnavailable: boolean }>({ citations: [], knowledgeUnavailable: false });
  const promptKey = useSearchParams()?.get('prompt') ?? null;
  const [seenPrompt, setSeenPrompt] = useState<string | null>(null);
  const [files, setFiles] = useState<TextAttachment[]>([]);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadFiles = useRef(new Map<string, File>());
  const uploadRequests = useRef(new Map<string, AbortController>());
  useEffect(() => { const requests = uploadRequests.current; return () => { for (const controller of requests.values()) controller.abort(); }; }, []);
  const [uploadCap, setUploadCap] = useState<'unknown' | 'available' | 'unavailable'>('unknown');
  /** Bumped when files are linked to the open chat, so "Files in this chat" reloads. */
  const [filesVersion, setFilesVersion] = useState(0);
  const routeThread = threadIdFromPath(usePathname());
  const [seenRoute, setSeenRoute] = useState(routeThread);
  useEffect(() => { const requests = uploadRequests.current; const files = uploadFiles.current; return () => { for (const controller of requests.values()) controller.abort(); files.clear(); }; }, [routeThread]);
  const [activeId, setActiveId] = useState<string | null>(routeThread);
  const [messages, setMessages] = useState<Message[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null);
  const [modelKey, setModelKey] = useState(models[0]?.key ?? '');
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<Capability[]>([]);
  const [picker, setPicker] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 });
  const [live, setLive] = useState<Live>(null);
  const sending = useRef(false);
  const [recovery, setRecovery] = useState<ChatRecovery | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<ChatProblem | null>(null);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const pendingApprovals = useRef<PendingApproval[]>([]);
  const created = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const listId = useId();
  const activeRef = useRef<string | null>(activeId);
  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  const model = models.find((m) => m.key === modelKey && m.available !== false) ?? null;
  const busy = live !== null;
  const fail = (text: string) => setError({ text, connect: false });

  // The address changed (chat link, New chat, Back/Forward): show that chat. Adjusting state while
  // rendering, as React recommends for "reset when a prop changes", instead of an effect.
  if (routeThread !== seenRoute) {
    setSeenRoute(routeThread);
    if (routeThread !== activeId) {
      setRecovery(null); setActiveId(routeThread); setTurnAgent(null); setToolsUnavailable(false); setMessages([]); setApprovals([]); setError(null);
      setUploads([]);
      if (routeThread === null) { setAttached([]); setFiles([]); setFileNotice(null); setUploads([]); }
    }
  }

  // /workspace?prompt=<key> (Library, starters): a new chat opens with that starter in the box.
  // Only a known key is honoured, and the text comes from the dictionary, never from the URL.
  if (promptKey !== seenPrompt) {
    setSeenPrompt(promptKey);
    const starter = routeThread === null ? findStarter(promptKey) : null;
    if (starter) setDraft(t(starter.promptKey));
  }

  // URL selection is only a request: resolve it through the authorized API before creating a thread.
  useEffect(() => {
    if (activeId || !requestedAgent || !agentsApiAvailable) return;
    let current = true;
    void createAgentsClient().getAgent(requestedAgent).then((r) => {
      if (!current) return;
      if (r.ok && r.value?.agent?.id === requestedAgent && typeof r.value.agent.name === 'string') {
        setSelectedAgent({ id: requestedAgent, name: r.value.agent.name });
        setAgentFailed(null);
      } else setAgentFailed(requestedAgent);
    });
    return () => { current = false; };
  }, [activeId, requestedAgent]);
  const binding = savedAgent?.threadId === activeId ? savedAgent : null;
  const savedAgentBlocked = !!activeId && typeof binding?.agentId === 'string' && (!agentsApiAvailable || binding.unavailable === true);
  const agentBlocked = (!!activeId && !binding) || savedAgentBlocked || (!activeId && !!requestedAgent && (!agentsApiAvailable || selectedAgent?.id !== requestedAgent || agentFailed === requestedAgent));
  const agentNotice = activeId && !binding ? t('workspace.agent.loading') : agentBlocked ? t(!agentsApiAvailable ? 'workspace.agent.unverified' : savedAgentBlocked || agentFailed === requestedAgent ? 'workspace.agent.unavailable' : 'workspace.agent.loading') : null;
  const agentLabel = activeId
    ? turnAgent?.name ?? binding?.name ?? (binding?.agentId === null ? undefined : binding?.unavailable ? t('workspace.agent.unavailable') : typeof binding?.agentId === 'string' ? t('workspace.agent.loading') : agentsApiAvailable ? t('workspace.agent.saved') : undefined)
    : requestedAgent ? selectedAgent?.id === requestedAgent ? selectedAgent.name : t(agentFailed === requestedAgent ? 'workspace.agent.unavailable' : 'workspace.agent.loading') : undefined;

  // Load the selected chat. Not for a chat this view just started: its messages arrive by stream.
  useEffect(() => {
    if (!activeId || created.current === activeId) return;
    let current = true;
    fetch(`/api/v1/chat/threads/${encodeURIComponent(activeId)}`, { cache: 'no-store' })
      .then((r) => json<{ thread: Thread; messages: Message[] }>(r))
      .then(async (d) => {
        if (!current) return;
        if (d.thread.id !== activeId || !Array.isArray(d.messages)) throw new Error('Invalid conversation');
        setRecovery(loadChatRecovery(uploadScope, activeId));
        setMessages(d.messages.map((m) => ({ ...m, citations: parseAgentCitations(m.citations), knowledgeUnavailable: m.knowledgeUnavailable === true })));
        const agentId = typeof d.thread.agentId === 'string' ? d.thread.agentId : d.thread.agentId === null ? null : undefined;
        setSavedAgent({ threadId: activeId, agentId });
        if (typeof agentId === 'string') {
          const r = await createAgentsClient().getAgent(agentId);
          if (!current) return;
          setSavedAgent(r.ok && r.value?.agent?.id === agentId && typeof r.value.agent.name === 'string'
            ? { threadId: activeId, agentId, name: r.value.agent.name }
            : { threadId: activeId, agentId, unavailable: true });
        }
        setModelKey(d.thread.modelKey);
      })
      .catch(() => { if (current) setError({ text: 'This chat could not be opened.', connect: false }); });
    return () => { current = false; };
  }, [activeId, models, uploadScope]);

  // Leaving the chat while an answer streams (e.g. Back) stops that answer; it is not shown elsewhere.
  useEffect(() => {
    if (routeThread === null || routeThread !== created.current) { abort.current?.abort(); created.current = null; }
  }, [routeThread]);

  // A new chat puts the cursor in the message box (pointer devices only: no surprise keyboard on phones).
  useEffect(() => {
    if (activeId === null && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, [activeId]);

  useEffect(() => {
    fetch('/api/v1/chat/capabilities', { cache: 'no-store' }).then((r) => json<{ capabilities: Capability[] }>(r))
      .then((d) => setCapabilities(d.capabilities)).catch(() => setCapabilities([]));
  }, []);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, live]);

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

  function detach(c: Capability) { setAttached((a) => a.filter((x) => x !== c)); }

  /** The @ button: same picker as typing @, opened at the caret. */
  function openApps() {
    const el = input.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret); const after = draft.slice(caret);
    const insert = before === '' || /\s$/.test(before) ? '@' : ' @';
    const next = before + insert + after;
    setDraft(next);
    setPicker({ open: true, query: '', index: 0 });
    requestAnimationFrame(() => { el?.focus(); const at = before.length + insert.length; el?.setSelectionRange(at, at); });
  }

  const REFUSAL: Record<AttachmentRefusal, string> = {
    type: t('workspace.files.refusedType'), size: t('workspace.files.refusedSize'), count: t('workspace.files.refusedCount', { max: MAX_FILES }),
    empty: t('workspace.files.refusedEmpty'), unreadable: t('workspace.files.refusedUnreadable'),
  };

  const UPLOAD_REFUSAL: Record<UploadRefusal, string> = {
    type: t('workspace.upload.refusedType'), size: t('workspace.upload.refusedSize', { max: formatBytes(UPLOAD_MAX_BYTES, t.locale) }),
    count: t('workspace.upload.refusedCount', { max: MAX_UPLOADS }), empty: t('workspace.files.refusedEmpty'),
  };

  /**
   * Small text files are read in the browser and travel inside the message (the model reads them).
   * Documents (PDF, Office, images, larger text) are uploaded to the Files API and linked to the chat
   * once it exists; the composer says the assistant does not read those yet (contract C-4b).
   */
  async function addFiles(list: FileList | readonly File[] | null) {
    const incoming = [...(list ?? [])];
    if (incoming.length === 0) return;
    const accepted: TextAttachment[] = []; const refused: string[] = []; const queued: { item: UploadItem; file: File }[] = [];
    for (const f of incoming) {
      const route = routeFile(f, uploads.length + queued.length);
      if (route.kind === 'refuse') { refused.push(`${safeName(f.name)}: ${UPLOAD_REFUSAL[route.why]}`); continue; }
      if (route.kind === 'upload') {
        if (uploadCap === 'unavailable') { refused.push(`${safeName(f.name)}: ${t('workspace.upload.unavailable')}`); continue; }
        queued.push({ file: f, item: { id: `${f.name}:${f.size}:${f.lastModified}:${Math.random().toString(36).slice(2, 8)}`, name: f.name, size: f.size, status: 'uploading', fileId: null, attachedTo: null, message: null } });
        continue;
      }
      const why = refusalFor(f, files.length + accepted.length);
      if (why) { refused.push(`${safeName(f.name)}: ${REFUSAL[why]}`); continue; }
      try { accepted.push({ id: `${f.name}:${f.size}:${f.lastModified}:${Math.random().toString(36).slice(2, 8)}`, name: f.name, size: f.size, text: await readText(f) }); }
      catch { refused.push(`${safeName(f.name)}: ${REFUSAL.unreadable}`); }
    }
    if (accepted.length) setFiles((x) => [...x, ...accepted]);
    if (queued.length) { setUploads((x) => [...x, ...queued.map((q) => q.item)]); for (const q of queued) void upload(q.item, q.file); }
    setFileNotice(refused.length ? refused.join(' ') : null);
    input.current?.focus();
  }

  async function upload(item: UploadItem, file: File) {
    if (uploadRequests.current.has(item.id)) return;
    if (!uploadScope) { setFileNotice(t('workspace.upload.unavailable')); setUploads(x => x.filter(u => u.id !== item.id)); return; }
    const controller = new AbortController(); uploadRequests.current.set(item.id, controller); uploadFiles.current.set(item.id, file);
    const targetThread = activeRef.current;
    setUploads(x => x.map(u => u.id === item.id ? { ...u, status: 'uploading', message: null } : u));
    try {
      const r = await uploadSafely(file, mediaTypeFor(file), uploadScope, controller.signal, percent => {
        if (!controller.signal.aborted) setUploads(x => x.map(u => u.id === item.id ? { ...u, percent } : u));
      }, workspaceApi());
      if (controller.signal.aborted) return;
      if (r.kind === 'stored' || r.kind === 'existing') {
        setUploadCap('available'); let attachedTo: string | null = null;
        // Never attach an old upload to a different conversation opened while it was uploading.
        if (targetThread && activeRef.current === targetThread) {
          const a = await workspaceApi().attachFile(targetThread, r.file.id);
          if (a.ok) { attachedTo = targetThread; setFilesVersion(n => n + 1); }
          else setFileNotice(t('workspace.upload.attachFailed'));
        }
        setUploads(x => x.map(u => u.id === item.id ? { ...u, status: 'ready', fileId: r.file.id, attachedTo } : u));
        uploadFiles.current.delete(item.id); return;
      }
      const message = r.kind === 'failed'
        ? (t.locale === 'es' ? 'Subida rechazada. Reintente explícitamente.' : 'Upload rejected. Retry explicitly.')
        : (t.locale === 'es' ? 'Subida sin confirmar. Compruebe el archivo guardado; no se reenviará automáticamente.' : 'Upload unconfirmed. Check the saved file; it will not be resent automatically.');
      setFileNotice(message); setUploads(x => x.map(u => u.id === item.id ? { ...u, status: 'failed', message } : u));
    } catch { if (!controller.signal.aborted) { setFileNotice(t('workspace.upload.attachFailed')); setUploads(x => x.map(u => u.id === item.id ? { ...u, status: 'failed' } : u)); } }
    finally { uploadRequests.current.delete(item.id); }
  }
  function retryUpload(id: string) { const item = uploads.find(u => u.id === id); const file = uploadFiles.current.get(id); if (item && file) void upload(item, file); }

  /** Links uploads that finished before the chat existed (the first message creates it). */
  async function attachPending(threadId: string) {
    const ready = uploads.filter((u) => u.status === 'ready' && u.fileId && u.attachedTo !== threadId);
    if (!ready.length) return;
    const results = await Promise.all(ready.map((u) => workspaceApi().attachFile(threadId, u.fileId as string)));
    if (results.some((x) => x.ok)) setFilesVersion((n) => n + 1);
    if (results.some((x) => !x.ok)) setFileNotice(t('workspace.upload.attachFailed'));
  }
  function removeUpload(id: string) { uploadRequests.current.get(id)?.abort(); uploadFiles.current.delete(id); setUploads((x) => x.filter((u) => u.id !== id)); }

  function removeFile(id: string) { setFiles((x) => x.filter((f) => f.id !== id)); setFileNotice(null); }

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
    const message = ev.message && typeof ev.message === 'object' && typeof (ev.message as Message).id === 'string' ? ev.message as Message : undefined;
    if (ev.type === 'agent') {
      const identity = parseAgentIdentity(ev.agent);
      if (identity) setTurnAgent(identity);
      setToolsUnavailable(Array.isArray(ev.unavailableTools) && ev.unavailableTools.length > 0);
    } else if (ev.type === 'citations') {
      citationState.current = { citations: parseAgentCitations(ev.citations), knowledgeUnavailable: ev.knowledgeUnavailable === true };
    }

    if (ev.type === 'user' && message) setMessages((m) => [...m, message]);
    else if (ev.type === 'delta') setLive((l) => l && { ...l, text: l.text + (ev.text ?? '') });
    else if (ev.type === 'tool_start') setLive((l) => l && { ...l, tools: [...l.tools, { tool: ev.tool ?? '', provider: ev.provider }] });
    else if (ev.type === 'tool_result') setLive((l) => l && { ...l, tools: l.tools.map((t) => (t.tool === ev.tool && t.ok === undefined ? { ...t, ok: ev.ok === true, code: ev.code } : t)) });
    else if (ev.type === 'approval_required') {
      // Malformed payloads are dropped: a card is only shown for a well-formed, server-built request.
      const p = parsePendingApproval(ev.approval);
      if (p) pendingApprovals.current.push(p);
    } else if ((ev.type === 'done' || ev.type === 'error') && message) { setMessages((m) => [...m, { ...message, citations: parseAgentCitations(message.citations ?? citationState.current.citations), knowledgeUnavailable: message.knowledgeUnavailable ?? citationState.current.knowledgeUnavailable }]); flushApprovals(message.id); }
    if (ev.type === 'error') fail(turnProblem(ev.code));
  }

  function begin(): AbortController {
    const controller = new AbortController(); abort.current = controller;
    citationState.current = { citations: [], knowledgeUnavailable: false };
    setToolsUnavailable(false); setTurnAgent(null);
    setLive({ text: '', tools: [] }); setBusy(true);
    return controller;
  }
  function finish() { flushApprovals(null); setLive(null); setBusy(false); abort.current = null; }
  function stop() { abort.current?.abort(); }

  /** Runs one approved MCP call through the server (which claims the approval) and streams the answer. */
  async function runApproved(p: PendingApproval): Promise<RunResult> {
    if (busy || !model || p.threadId !== activeId) return { ok: false, code: 'INTERRUPTED' };
    setError(null);
    const controller = begin();
    let result: RunResult = { ok: false, code: 'INTERRUPTED' };
    try {
      const res = await fetch(`/api/v1/chat/threads/${p.threadId}/approved-call`, {
        method: 'POST', signal: controller.signal, headers: MUTATION_HEADERS,
        body: JSON.stringify({
          callId: p.callId, modelKey: model.key, connectionId: p.endpointId, capability: p.capability,
          arguments: p.arguments, argumentsSha256: p.argumentsSha256, timeZone: timeZone(),
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
        if (!controller.signal.aborted) handleEvent(ev);
      });
      if (summary.terminal === null && !controller.signal.aborted) fail(turnProblem('INTERRUPTED'));
      return result;
    } catch {
      if (!controller.signal.aborted) fail('The approved call could not be sent.');
      return result;
    } finally { finish(); }
  }

  async function reconcile() {
    if (!recovery || reconciling) return;
    const id = recovery.threadId;
    setReconciling(true);
    try {
      const d = await json<{ thread: Thread; messages: Message[] }>(await fetch(`/api/v1/chat/threads/${encodeURIComponent(id)}`, { cache: 'no-store' }));
      if (activeRef.current !== id) return;
      if (!Array.isArray(d.messages) || d.thread.id !== id) throw new Error('Invalid conversation');
      setMessages(d.messages.map((m) => ({ ...m, citations: parseAgentCitations(m.citations), knowledgeUnavailable: m.knowledgeUnavailable === true })));
      if (!hasRecoveredAnswer(recovery, d.messages)) { fail(t('workspace.chat.stillUnresolved')); return; }
      if (!clearChatRecovery(uploadScope, id)) { fail(t('workspace.chat.stillUnresolved')); return; }
      setRecovery(null); setError(null);
    } catch { if (activeRef.current === id) fail(t('workspace.chat.recoveryFailed')); }
    finally { setReconciling(false); }
  }

  async function send() {
    const content = composeContent(draft, files);
    if (!content || sending.current || recovery || agentBlocked || busy || !model || content.length > MESSAGE_LIMIT || uploads.some((u) => u.status === 'uploading')) return;
    sending.current = true;
    let partial = '';
    let pending: ChatRecovery | null = null;
    const remember = () => { if (pending) { pending = { ...pending, partial }; saveChatRecovery(uploadScope, pending); if (activeRef.current === pending.threadId || created.current === pending.threadId) setRecovery(pending); } };
    const typed = draft; const sentFiles = files;
    setError(null);
    let id = activeId;
    try {
      if (!id) {
        const d = await json<{ thread: Thread }>(await fetch('/api/v1/chat/threads', {
          method: 'POST', headers: MUTATION_HEADERS, body: JSON.stringify({ modelKey: model.key, ...(agentsApiAvailable && requestedAgent && selectedAgent?.id === requestedAgent ? { agentId: selectedAgent.id } : {}) }),
        }));
        id = d.thread.id; setSavedAgent({ threadId: id, agentId: d.thread.agentId, ...(d.thread.agentId && selectedAgent?.id === d.thread.agentId ? { name: selectedAgent.name } : {}) }); created.current = id; setActiveId(id); add(d.thread);
        // Address follows the new chat without a navigation, so the answer below keeps streaming.
        window.history.replaceState(null, '', threadHref(id));
      }
    } catch { sending.current = false; fail('A new chat could not be started.'); return; }
    pending = { threadId: id, original: content, partial: '' };
    if (!saveChatRecovery(uploadScope, pending)) { sending.current = false; fail(t('workspace.chat.storageUnavailable')); return; }
    void attachPending(id);
    const controller = begin();
    setDraft(''); setFiles([]); setFileNotice(null); setUploads((x) => x.filter((u) => u.status === 'failed'));
    const mentions = attached.map((c) => ({ capability: c.capabilityKey, provider: c.providerKey }));
    try {
      const res = await fetch(`/api/v1/chat/threads/${id}/messages`, {
        method: 'POST', signal: controller.signal, headers: MUTATION_HEADERS,
        body: JSON.stringify({ content, modelKey: model.key, mentions, timeZone: timeZone() }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(requestProblem(body.error));
        if (res.status >= 500 || res.status === 404 || res.status === 409 || res.ok) { remember(); if (res.status === 409) setDraft(typed); }
        else { clearChatRecovery(uploadScope, id); setDraft(typed); setFiles(sentFiles); }
        return;
      }
      const summary = await readTurnStream(res.body, (ev) => { if (!controller.signal.aborted) { if (ev.type === 'delta') partial += ev.text ?? '';
        if (pending && ev.type === 'user' && ev.message && typeof (ev.message as Message).id === 'string') pending.userMessageId = (ev.message as Message).id;
        if (pending && (ev.type === 'user' || ev.type === 'delta')) saveChatRecovery(uploadScope, { ...pending, partial });
        handleEvent(ev); } });
      // A stream that ends without done/error was cut off; never present it as a finished answer.
      if (summary.terminal === null || controller.signal.aborted) { remember(); fail(turnProblem('INTERRUPTED')); }
      else clearChatRecovery(uploadScope, id);
      setAttached([]);
      touch(id, typed.trim() || sentFiles[0]?.name || content);
    } catch {
      remember();
      if (!controller.signal.aborted) fail('The response was interrupted. Check saved messages before sending again.');
    } finally { sending.current = false; finish(); }
  }

  const showPicker = picker.open && capabilities !== null;
  const activeOption = showPicker && matches[picker.index] ? `${listId}-${picker.index}` : undefined;

  const length = composeContent(draft, files).length;

  return {
    recovery, reconcile, reconciling, agentBlocked, agentNotice, agentLabel, toolsUnavailable,
    activeId, messages, approvals, live, error, busy, models, model, modelKey, setModelKey,
    draft, setDraft, attached, matches, picker, showPicker, activeOption, listId, input, log,
    files, fileNotice, length, overLimit: length > MESSAGE_LIMIT,
    uploads, retryUpload, uploadCap, uploading: uploads.some((u) => u.status === 'uploading'), filesVersion,
    onDraft, onKey, choose, detach, openApps, addFiles, removeFile, removeUpload, send, stop, runApproved,
  };
}

export type ChatSession = ReturnType<typeof useChatSession>;
