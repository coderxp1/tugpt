import type { BackendGap } from '@/lib/connect-ui/contract';
import s from './connect.module.css';

/**
 * States plainly, in customer words, that something is not available yet.
 * The internal dependency id stays on the element (data-gap) for support and
 * tests; the technical "needs" text is not shown to customers.
 */
export function GapNote({ gap, children, label = 'Not available yet' }: { gap: BackendGap; children?: React.ReactNode; label?: string }) {
  return (
    <div className={s.gap} role="note" data-gap={gap.id}>
      <strong>{label}</strong>
      <span>{children ?? gap.title}</span>
    </div>
  );
}
