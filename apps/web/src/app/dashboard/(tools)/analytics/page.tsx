import { UsageAnalytics } from '@/components/analytics/UsageAnalytics';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';

export default function AnalyticsPage() {
  return <>
    <p className={s.gap} role="note" data-testid="analytics-partial"><strong>Partly available</strong><span>Chat messages are not counted here yet, so totals can read 0 even when your team uses Chat.</span></p>
    <UsageAnalytics />
  </>;
}
