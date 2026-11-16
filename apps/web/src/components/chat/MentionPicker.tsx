'use client';

import Link from 'next/link';
import { pickerBlock } from '@/lib/connect-ui/chat-errors';
import s from './chat.module.css';

export interface Capability {
  capabilityKey: string; providerKey: string; providerName: string; description: string; permissionClass: string;
  state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available';
  /** false when the catalogue lists it but chat has no tool for it on this build. */
  toolAvailable?: boolean;
  /** MCP only: which gate keeps it off (see pickerBlock). */
  unavailableReason?: string;
}

export interface MentionPickerProps {
  id: string;
  matches: readonly Capability[];
  activeIndex: number;
  modelCanUseTools: boolean;
  onChoose(c: Capability): void;
}

/** The @ listbox. Unusable apps stay visible with the reason, but cannot be chosen. */
export function MentionPicker({ id, matches, activeIndex, modelCanUseTools, onChoose }: MentionPickerProps) {
  const anyConnected = matches.some((c) => c.state === 'connected' && c.toolAvailable !== false);
  return (
    <ul id={id} role="listbox" aria-label="Apps you can use" className={s.picker}>
      {matches.length === 0 && <li className={s.muted} role="presentation">No matching apps. <Link href="/dashboard/connect">Open Connect</Link></li>}
      {matches.map((c, i) => {
        const block = pickerBlock(c, modelCanUseTools);
        return (
          <li key={`${c.providerKey}:${c.capabilityKey}:${c.providerName}:${i}`} id={`${id}-${i}`} role="option" aria-selected={i === activeIndex} aria-disabled={block !== null}
            className={`${s.option} ${i === activeIndex ? s.optionActive : ''} ${block ? s.optionOff : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onChoose(c); }}>
            <strong>{c.providerName}</strong><span>{c.description}</span><em>{block ?? 'Connected'}</em>
          </li>
        );
      })}
      {anyConnected && !modelCanUseTools && (
        <li className={s.muted} role="presentation">The selected model has not passed tool-calling verification yet, so apps are switched off for it.</li>
      )}
    </ul>
  );
}
