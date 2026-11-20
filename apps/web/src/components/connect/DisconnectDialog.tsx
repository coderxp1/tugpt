'use client';

import type { BackendGap } from '@/lib/connect-ui/contract';
import { ConfirmDialog } from './ConfirmDialog';
import { GapNote } from './GapNote';
import { useT } from '@/i18n/provider';

export interface DisconnectDialogProps {
  providerName: string;
  /** Performs the disconnect; resolves to an error message or null. Absent = no backend route on this build. */
  onConfirm?: () => Promise<string | null>;
  gap?: BackendGap;
  onClose(): void;
  onDone?(): void;
}

/** Confirmation before revoking a provider connection. */
export function DisconnectDialog({ providerName, onConfirm, gap, onClose, onDone }: DisconnectDialogProps) {
  const t = useT();
  const provider = providerName;
  return (
    <ConfirmDialog
      title={t('connect.disconnect.title', { provider })}
      confirmLabel={t('connect.disconnect.confirm', { provider })}
      busyLabel={t('connect.disconnect.busy')}
      onConfirm={onConfirm}
      onClose={onClose}
      onDone={onDone}
      unavailable={gap
        ? <GapNote gap={gap}>{t('connect.disconnect.unavailable', { provider })}</GapNote>
        : <p>{t('connect.disconnect.unavailable', { provider })}</p>}
    >
      <p>{t('connect.disconnect.intro')}</p>
      <ul>
        <li>{t('connect.disconnect.li1', { provider })}</li>
        <li>{t('connect.disconnect.li2')}</li>
        <li>{t('connect.disconnect.li3')}</li>
      </ul>
    </ConfirmDialog>
  );
}
