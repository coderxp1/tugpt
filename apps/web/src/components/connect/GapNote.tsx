import type { BackendGap } from '@/lib/connect-ui/contract';
import s from './connect.module.css';

/** States plainly that a feature waits on the backend, and on exactly what. */
export function GapNote({ gap, children }: { gap: BackendGap; children?: React.ReactNode }) {
  return (
    <div className={s.gap} role="note">
      <strong>Waiting on backend · {gap.id}</strong>
      <span>{children ?? gap.title}</span>
      <small>Needs: {gap.needs}</small>
    </div>
  );
}
