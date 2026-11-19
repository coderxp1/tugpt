'use client';

import Link from 'next/link';
import { Fragment, type RefObject } from 'react';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { Icon } from '@/components/workspace/icons';
import { splitAttachments } from '@/lib/workspace/attachments';
import { toolLabel, toolProblem } from '@/lib/connect-ui/chat-errors';
import type { PendingApproval } from '@/lib/chat/approval';
import type { ApprovalItem, Live, Message, RunResult } from './types';
import s from './chat.module.css';

export interface ConversationProps {
  readonly messages: Message[];
  readonly approvals: ApprovalItem[];
  readonly live: Live;
  readonly busy: boolean;
  readonly canApprove: boolean;
  readonly logRef: RefObject<HTMLDivElement | null>;
  onRun(approval: PendingApproval): Promise<RunResult>;
}

/** A user message: what was typed, and any attached text files as chips (their text went to the model). */
function UserText({ content, stopped }: { content: string; stopped: boolean }) {
  const { text, files } = splitAttachments(content);
  return (
    <>
      {files.length > 0 && <ul className={s.sentFiles} aria-label="Attached files">{files.map((f, i) => (
        <li key={`${f.name}:${i}`}><Icon name="file" size={14} /><span>{f.name}</span></li>
      ))}</ul>}
      {(text || files.length === 0) && <div className={s.text}>{text || (stopped ? 'Stopped.' : '')}</div>}
    </>
  );
}

/** The message log of one chat: messages, tool steps, approval cards and the answer that is streaming. */
export function Conversation({ messages, approvals, live, busy, canApprove, logRef, onRun }: ConversationProps) {
  const card = (it: ApprovalItem) => (
    <ApprovalCard key={`${it.approval.threadId}:${it.approval.callId}`} approval={it.approval} canApprove={canApprove} busy={busy} onRun={onRun} />
  );
  const placed = new Set(messages.map((m) => m.id));
  return (
    <div ref={logRef} className={s.log} role="log" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
      {messages.map((m) => <Fragment key={m.id}>{m.role === 'tool'
        ? <p className={m.status === 'error' ? s.toolFail : s.toolOk}>{m.content}</p>
        : <article className={m.role === 'user' ? s.user : s.assistant} aria-label={m.role === 'user' ? 'You' : 'TuGPT'}>
            {m.mentions.length > 0 && <div className={s.mentions}>{m.mentions.map((x) => <span key={x.capability + x.provider} className={s.chip}>@{x.provider} {x.capability}</span>)}</div>}
            {m.role === 'assistant' && m.content ? <Markdown text={m.content} /> : <UserText content={m.content} stopped={m.status === 'stopped'} />}
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
  );
}
