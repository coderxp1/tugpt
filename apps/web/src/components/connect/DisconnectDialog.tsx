'use client';

import type { BackendGap } from '@/lib/connect-ui/contract';
import { ConfirmDialog } from './ConfirmDialog';
import { GapNote } from './GapNote';

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
  return (
    <ConfirmDialog
      title={`Disconnect ${providerName}?`}
      confirmLabel={`Disconnect ${providerName}`}
      busyLabel="Disconnecting…"
      onConfirm={onConfirm}
      onClose={onClose}
      onDone={onDone}
      unavailable={gap
        ? <GapNote gap={gap}>Disconnecting from TuGPT is not available yet. Until it is, an admin can remove TuGPT&rsquo;s access in the {providerName} account&rsquo;s own security settings.</GapNote>
        : <p>Disconnecting from TuGPT is not available yet. An admin can remove TuGPT&rsquo;s access in the {providerName} account&rsquo;s own security settings.</p>}
    >
      <p>TuGPT will revoke its access to this account:</p>
      <ul>
        <li>Chat can no longer read {providerName} data with <kbd>@</kbd>.</li>
        <li>Everyone in your organization who uses this connection loses it.</li>
        <li>Past chats stay as they are. You can connect again at any time.</li>
      </ul>
    </ConfirmDialog>
  );
}
