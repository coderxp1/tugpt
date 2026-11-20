import s from './chat.module.css';

export type ToolRunState = 'running' | 'completed' | 'awaiting' | 'failed' | 'not_run';
const LABEL: Record<ToolRunState, string> = { running: 'Running', completed: 'Completed', awaiting: 'Waiting for approval', failed: 'Failed', not_run: 'Not run' };
const GLYPH: Record<ToolRunState, string> = { running: '◌', completed: '✓', awaiting: '⏸', failed: '✕', not_run: '–' };

/** One visual language for every tool state in Chat. The glyph is decorative; the text carries the meaning. */
export function ToolState({ state }: { state: ToolRunState }) {
  return <span className={`${s.toolPill} ${s[`tool_${state}`] ?? ''}`} data-tool-pill={state}><span aria-hidden="true">{GLYPH[state]}</span> {LABEL[state]}</span>;
}
