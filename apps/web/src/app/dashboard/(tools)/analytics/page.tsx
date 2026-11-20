import type { Metadata } from 'next';
import { UsageAnalytics } from '@/components/analytics/UsageAnalytics';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Usage & Costs · TuGPT' };

/**
 * Usage is partly tracked: only usage written to the provider usage ledger is summed.
 * Chat and image generation on TuGPT's own models write no usage records yet, so the
 * page says so up front instead of letting an empty total read as "nothing used".
 */
export default function AnalyticsPage() {
  return <UsageAnalytics intro={
    <section className={s.coverage} aria-labelledby="coverage-h" data-testid="analytics-partial">
      <h2 id="coverage-h"><span className={`${s.badge} ${s.idle}`}>Partly available</span> What this page counts</h2>
      <div className={s.coverageGrid}>
        <div data-coverage="recorded"><h3>Recorded here</h3>
          <p>Calls to AI providers that TuGPT records for your organization, with the number of calls, tokens and, where a price is known, the cost.</p></div>
        <div data-coverage="untracked"><h3>Not tracked yet</h3>
          <ul><li>Chat messages</li><li>Image generation</li><li>MCP tool use</li></ul>
          <p>These are not counted anywhere on this page. A total of 0 does not mean your team used nothing.</p></div>
      </div>
    </section>} />;
}
