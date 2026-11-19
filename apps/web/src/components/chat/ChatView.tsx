'use client';

import Link from 'next/link';
import { useThreads } from '@/components/workspace/ThreadsProvider';
import { useT } from '@/i18n/provider';
import { Icon } from '@/components/workspace/icons';
import { ChatFiles } from './ChatFiles';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import { Greeting, Starters } from './NewChatHome';
import { useChatSession } from './useChatSession';
import type { PublicModel } from './types';
import s from './chat.module.css';

export interface ChatViewProps {
  models: PublicModel[];
  /** Owner or admin of the active organization: may approve MCP calls (the backend checks again). */
  canApprove?: boolean;
  /** For the greeting on a new chat. Never the email address. */
  firstName?: string | null;
}

/**
 * The Workspace chat. A new chat is a greeting, a large composer and starters; once there is a
 * conversation, the composer docks at the bottom. Model, agent, @ apps and files live in the
 * composer, so switching any of them never changes the layout. Recent chats live in the sidebar.
 */
export function ChatView({ models, canApprove = false, firstName = null }: ChatViewProps) {
  const c = useChatSession(models);
  const t = useT();
  const { threads, manage } = useThreads();
  const title = (c.activeId && threads?.find((x) => x.id === c.activeId)?.title) || 'New chat';
  const fresh = c.activeId === null && c.messages.length === 0 && c.live === null && c.approvals.length === 0;

  function pickStarter(text: string) {
    c.setDraft(text);
    requestAnimationFrame(() => { const el = c.input.current; el?.focus(); el?.setSelectionRange(text.length, text.length); });
  }

  return (
    <section className={`${s.view} ${fresh ? s.fresh : ''}`} aria-labelledby="chat-title">
      <header className={s.bar}>
        <h1 id="chat-title" className={s.title} title={title}>{title}</h1>
        {c.model?.private && <span className={s.privacy}><Icon name="lock" size={14} />{t('workspace.model.privateNote')}</span>}
      </header>
      {c.activeId && manage === 'available' && <ChatFiles threadId={c.activeId} version={c.filesVersion} />}

      <div className={s.stage}>
        {fresh
          ? <Greeting name={firstName} />
          : <Conversation messages={c.messages} approvals={c.approvals} live={c.live} busy={c.busy} canApprove={canApprove} logRef={c.log} onRun={c.runApproved} />}

        {c.error && <p className={s.error} role="alert">{c.error.text}{c.error.connect && <> <Link href="/dashboard/connect">Open Connect</Link></>}</p>}
        {models.length === 0 && <p className={s.error} role="alert">{t('workspace.model.noneConfigured')}</p>}

        <Composer draft={c.draft} attached={c.attached} matches={c.matches} pickerIndex={c.picker.index} showPicker={c.showPicker}
          activeOption={c.activeOption} listId={c.listId} models={models} modelKey={c.modelKey} model={c.model} busy={c.busy}
          disabled={models.length === 0} inputRef={c.input} files={c.files} fileNotice={c.fileNotice} uploads={c.uploads} uploadCap={c.uploadCap} onRemoveUpload={c.removeUpload} length={c.length} overLimit={c.overLimit}
          hero={fresh} onDraft={c.onDraft} onKey={c.onKey} onChoose={c.choose} onDetach={c.detach} onModel={c.setModelKey} onApps={c.openApps}
          onFiles={(f) => void c.addFiles(f)} onRemoveFile={c.removeFile} onSend={() => void c.send()} onStop={c.stop} />

        {fresh && <Starters onPick={pickStarter} disabled={models.length === 0} />}
      </div>
    </section>
  );
}
