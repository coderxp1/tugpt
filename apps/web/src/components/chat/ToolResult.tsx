'use client';

import Link from 'next/link';
import { useT } from '@/i18n/provider';
import { parseStoredToolResult, toolProblem } from '@/lib/connect-ui/chat-errors';
import { ToolState } from './ToolState';
import type { Capability } from './MentionPicker';
import s from './chat.module.css';

export interface ToolResultProps {
  /** Server-written line: "<Provider> responded" or "<Provider> failed: <CODE>". */
  content: string;
  status: 'complete' | 'error' | 'stopped';
  /** Built-in catalogue key; null for customer MCP tools. */
  capabilityKey: string | null;
  capability?: Capability | null;
}

/**
 * One tool call in a saved chat. It reports only what the server stored: which
 * app, whether it completed and, on failure, the error code. The raw tool output
 * is not stored, and the block says so instead of implying it can show it.
 */
export function ToolResult({ content, status, capabilityKey, capability = null }: ToolResultProps) {
  const t = useT();
  const r = parseStoredToolResult(content, status);
  const name = r.provider ?? capability?.providerName ?? t('chat.result.integration');
  const problem = r.ok ? null : toolProblem(r.code ?? undefined, t);
  const state = r.ok ? 'completed' : 'failed';
  return (
    <section className={`${s.toolBlock} ${r.ok ? '' : s.toolBlockFail}`} data-tool-state={state} aria-label={t('chat.result.aria', { name })}>
      <p className={s.toolBlockHead}>
        <ToolState state={state} /> <strong>{name}</strong> <span>{r.ok ? t('chat.result.ok') : t('chat.result.failed')}</span>
      </p>
      {problem && (
        <p className={s.toolBlockFix}>{problem.text}{problem.connect && <> <Link href="/dashboard/connect">{t('chat.openConnect')}</Link></>}</p>
      )}
      <details>
        <summary>{t('chat.result.details')}</summary>
        <dl>
          <dt>{t('chat.result.tool')}</dt>
          <dd>{capability ? capability.description : capabilityKey ? <code>{capabilityKey}</code> : t('chat.result.customTool')}</dd>
          <dt>{t('chat.result.output')}</dt>
          <dd>{r.ok ? t('chat.result.outputNote') : t('chat.result.outputNone')}</dd>
          {r.code && <><dt>{t('chat.result.code')}</dt><dd><code lang="en">{r.code}</code></dd></>}
        </dl>
      </details>
    </section>
  );
}
