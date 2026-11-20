import Link from 'next/link';
import { STATE_LABEL, type FeatureState, type FeatureStatus } from '@/lib/hub/features';
import s from '@/components/connect/connect.module.css';

const TONE: Record<FeatureState, string> = { available: s.ok, partial: s.idle, disabled: s.off, not_implemented: s.off };

/** What this organization can use now. Read from the real gates; nothing here can be toggled. */
export function FeatureStatusPanel({ features }: { features: readonly FeatureStatus[] }) {
  return (
    <section className={s.section} aria-labelledby="features-h" id="features">
      <h2 id="features-h">Features for your organization</h2>
      <p className={s.lead}>What your organization can use in TuGPT right now. Statuses are checked when this page loads.</p>
      <div className={s.tableWrap}><table className={s.table}>
        <caption className={s.sr}>Feature status</caption>
        <thead><tr><th scope="col">Feature</th><th scope="col">Status</th><th scope="col">What this means</th></tr></thead>
        <tbody>{features.map((f) => (
          <tr key={f.key} data-feature={f.key} data-state={f.state}>
            <th scope="row">{f.href ? <Link href={f.href} prefetch={false}>{f.name}</Link> : f.name}</th>
            <td><span className={`${s.badge} ${TONE[f.state]}`}>{STATE_LABEL[f.state]}</span></td>
            <td>{f.detail}</td>
          </tr>))}
        </tbody>
      </table></div>
    </section>
  );
}
