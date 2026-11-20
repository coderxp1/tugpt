'use client';

import Link from 'next/link';
import { useId, useRef, useState, type RefObject } from 'react';
import { useT } from '@/i18n/provider';
import { Icon } from '@/components/workspace/icons';
import { ACCEPT_ATTRIBUTE, MESSAGE_LIMIT, type TextAttachment } from '@/lib/workspace/attachments';
import { UPLOAD_ACCEPT, formatBytes } from '@/lib/workspace/uploads';
import type { UploadItem } from './useChatSession';
import { WORKSPACE_IMAGES } from '@/lib/workspace/routes';
import { AgentMenu } from './AgentMenu';
import { AgentIdentity } from './AgentIdentity';
import { MentionPicker, type Capability } from './MentionPicker';
import { ModelMenu } from './ModelMenu';
import type { PublicModel } from './types';
import s from './chat.module.css';

export interface ComposerProps {
  readonly agentLabel?: string;
  readonly draft: string;
  readonly attached: Capability[];
  readonly matches: Capability[];
  readonly pickerIndex: number;
  readonly showPicker: boolean;
  readonly activeOption: string | undefined;
  readonly listId: string;
  readonly models: readonly PublicModel[];
  readonly modelKey: string;
  readonly model: PublicModel | null;
  readonly busy: boolean;
  /** No model is configured: nothing can be sent. */
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly files: readonly TextAttachment[];
  readonly fileNotice: string | null;
  /** Documents uploaded to the Files API for this chat (when the API is available). */
  readonly uploads?: readonly UploadItem[];
  readonly uploadCap?: 'unknown' | 'available' | 'unavailable';
  readonly length: number;
  readonly overLimit: boolean;
  /** The large, centred composer of a new chat. */
  readonly hero?: boolean;
  onDraft(value: string): void;
  onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void;
  onChoose(c: Capability): void;
  onDetach(c: Capability): void;
  onModel(key: string): void;
  onApps(): void;
  onFiles(files: FileList | File[] | null): void;
  onRemoveFile(id: string): void;
  onRemoveUpload?(id: string): void;
  onSend(): void;
  onStop(): void;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** The message box: attached @ apps and files, the @ picker, model and agent, Send / Stop. */
export function Composer({ inputRef, ...p }: ComposerProps) {
  const t = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const counterId = useId();
  const uploads = p.uploads ?? [];
  const uploading = uploads.some((x) => x.status === 'uploading');
  const docs = p.uploadCap !== 'unavailable';
  const canSend = !p.disabled && (p.draft.trim().length > 0 || p.files.length > 0) && !!p.model && !p.overLimit && !uploading;
  const nearLimit = p.files.length > 0 || p.length > MESSAGE_LIMIT * 0.8;

  return (
    <form className={`${s.composer} ${p.hero ? s.composerHero : ''}`} onSubmit={(e) => { e.preventDefault(); p.onSend(); }}>
      <AgentIdentity label={p.agentLabel} />
      <div className={`${s.box} ${dragging ? s.dragging : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); p.onFiles(e.dataTransfer.files); } }}>
        {(p.attached.length > 0 || p.files.length > 0 || uploads.length > 0) && (
          <div className={s.attachments}>
            {p.attached.length > 0 && <div className={s.mentions} aria-label="Attached apps">{p.attached.map((c) => (
              <span key={c.providerKey + c.capabilityKey} className={s.chip}>@{c.providerName} · {c.description}
                <button type="button" aria-label={`Remove ${c.providerName}`} onClick={() => p.onDetach(c)}>×</button></span>
            ))}</div>}
            {p.files.length > 0 && <ul className={s.fileChips} aria-label={t('workspace.files.attached')}>{p.files.map((f) => (
              <li key={f.id} className={s.fileChip}><Icon name="file" size={15} /><span className={s.fileName} title={f.name}>{f.name}</span><small>{kb(f.size)}</small>
                <button type="button" aria-label={t('workspace.files.remove', { name: f.name })} onClick={() => p.onRemoveFile(f.id)}><Icon name="close" size={14} /></button></li>
            ))}</ul>}
            {uploads.length > 0 && <ul className={s.fileChips} aria-label={t('workspace.upload.listLabel')}>{uploads.map((f) => (
              <li key={f.id} className={`${s.fileChip} ${f.status === 'failed' ? s.fileChipFailed : ''}`}>
                <Icon name={f.status === 'failed' ? 'alert' : f.status === 'ready' ? 'check' : 'upload'} size={15} />
                <span className={s.fileName} title={f.message ? `${f.name}: ${f.message}` : f.name}>{f.name}</span>
                <small>{f.status === 'uploading' ? t('workspace.upload.uploading') : f.status === 'failed' ? t('workspace.upload.failed') : formatBytes(f.size, t.locale)}</small>
                {f.status !== 'uploading' && p.onRemoveUpload && <button type="button" aria-label={t('workspace.files.remove', { name: f.name })} onClick={() => p.onRemoveUpload?.(f.id)}><Icon name="close" size={14} /></button>}
              </li>
            ))}</ul>}
          </div>
        )}
        <label htmlFor="chat-input" className={s.sr}>Message</label>
        <textarea id="chat-input" ref={inputRef} value={p.draft} rows={p.hero ? 3 : 1} maxLength={MESSAGE_LIMIT} placeholder={t('workspace.composer.placeholder')}
          className={s.input} onChange={(e) => p.onDraft(e.target.value)} onKeyDown={p.onKey} disabled={p.disabled}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); p.onFiles(e.clipboardData.files); } }}
          aria-describedby={nearLimit ? counterId : undefined}
          role="combobox" aria-expanded={p.showPicker} aria-controls={p.listId} aria-autocomplete="list" aria-activedescendant={p.activeOption} />

        <div className={s.toolbar}>
          <input ref={fileInput} type="file" multiple accept={docs ? `${ACCEPT_ATTRIBUTE},${UPLOAD_ACCEPT}` : ACCEPT_ATTRIBUTE} className={s.sr} tabIndex={-1} aria-hidden="true"
            onChange={(e) => { p.onFiles(e.target.files); e.target.value = ''; }} />
          <button type="button" className={s.iconTool} onClick={() => fileInput.current?.click()} disabled={p.disabled || p.busy}
            aria-label={docs ? t('workspace.upload.attach') : t('workspace.files.attach')} title={docs ? t('workspace.upload.attachHint') : t('workspace.files.attachHint')}><Icon name="clip" /></button>
          <button type="button" className={s.iconTool} onClick={p.onApps} disabled={p.disabled || p.busy}
            aria-label={t('workspace.composer.apps')} title={t('workspace.composer.apps')}><Icon name="at" /></button>
          <AgentMenu label={p.agentLabel} disabled={p.disabled || p.busy} />
          <Link href={WORKSPACE_IMAGES} prefetch={false} className={`${s.iconTool} ${s.hideNarrow}`} aria-label={t('workspace.composer.image')} title={t('workspace.composer.image')}
            aria-disabled={p.busy ? 'true' : undefined} onClick={(e) => { if (p.busy) e.preventDefault(); }}><Icon name="images" /></Link>
          <span className={s.spacer} />
          {nearLimit && <span id={counterId} className={`${s.counter} ${p.overLimit ? s.counterOver : ''}`} aria-live="polite">
            {t('workspace.composer.count', { used: p.length.toLocaleString(), max: MESSAGE_LIMIT.toLocaleString() })}</span>}
          <ModelMenu models={p.models} value={p.modelKey} disabled={p.busy || p.disabled} onChange={p.onModel} />
          {p.busy
            ? <button type="button" className={s.stop} onClick={p.onStop} aria-label="Stop" title="Stop"><Icon name="stop" /></button>
            : <button type="submit" className={s.send} disabled={!canSend} aria-label="Send" title="Send"><Icon name="arrowUp" /></button>}
        </div>
        {p.showPicker && <MentionPicker id={p.listId} matches={p.matches} activeIndex={p.pickerIndex} modelCanUseTools={p.model?.toolCalling ?? false} onChoose={p.onChoose} />}
        {dragging && <div className={s.dropHint} aria-hidden="true">{t('workspace.files.drop')}</div>}
      </div>
      {p.fileNotice && <p className={s.fileNotice} role="status">{p.fileNotice}</p>}
      {uploads.length > 0 && <p className={s.uploadNote} role="status">{uploading ? t('workspace.upload.waitToSend') : t('workspace.upload.notRead')}</p>}
      {p.overLimit && <p className={s.fileNotice} role="status">{t('workspace.composer.tooLong', { max: MESSAGE_LIMIT.toLocaleString() })}</p>}
      <p className={s.hint}>{t('workspace.composer.hint')}</p>
    </form>
  );
}
