'use client';

import { useT } from '@/i18n/provider';
import type { Attachment } from '@/lib/workspace-data/contracts';
import { hasArray, workspaceApi } from '@/lib/workspace/service';
import { formatBytes } from '@/lib/workspace/uploads';
import { Icon } from '@/components/workspace/icons';
import { useLoad } from '@/components/workspace/useLoad';
import s from './chat.module.css';

/**
 * "Files in this chat": documents linked to the open chat, each a download link (the route sends
 * Content-Disposition: attachment). Nothing is shown while loading, when there are none, or when
 * the attachments API is not available, so a chat without files looks exactly as before.
 */
export function ChatFiles({ threadId, version }: { threadId: string; version: number }) {
  const t = useT();
  const { load } = useLoad<{ attachments: readonly Attachment[] }>(`${threadId}:${version}`, () => workspaceApi().listAttachments(threadId), (v) => hasArray(v, 'attachments'));
  if (load.state !== 'ready' || load.value.attachments.length === 0) return null;
  const api = workspaceApi();
  return (
    <details className={s.chatFiles}>
      <summary><Icon name="clip" size={15} />{t('workspace.upload.inChat', { count: load.value.attachments.length })}</summary>
      <ul>
        {load.value.attachments.map(({ file }) => (
          <li key={file.id}>
            <Icon name="file" size={15} />
            <span className={s.fileName} title={file.filename}>{file.filename}</span>
            <small>{formatBytes(file.sizeBytes, t.locale)}</small>
            {file.status === 'ready'
              ? <a href={api.fileContentUrl(file.id)} download aria-label={t('workspace.upload.download', { name: file.filename })}><Icon name="download" size={15} /></a>
              : <small>{t(file.status === 'failed' ? 'workspace.upload.failed' : 'workspace.upload.uploading')}</small>}
          </li>
        ))}
      </ul>
      <p>{t('workspace.upload.notRead')}</p>
    </details>
  );
}
