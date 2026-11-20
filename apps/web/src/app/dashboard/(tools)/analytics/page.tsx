import type { Metadata } from 'next';
import { UsageAnalytics } from '@/components/analytics/UsageAnalytics';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getRequestLocale());
  return { title: t('usage.metaTitle') };
}

/**
 * Usage is partly tracked: only usage written to the provider usage ledger is summed.
 * Chat, image generation and MCP tool use write no usage records yet, so the page says
 * so up front instead of letting an empty total read as "nothing used".
 */
export default async function AnalyticsPage() {
  const t = createTranslator(await getRequestLocale());
  return <UsageAnalytics intro={
    <section className={s.coverage} aria-labelledby="coverage-h" data-testid="analytics-partial">
      <h2 id="coverage-h"><span className={`${s.badge} ${s.idle}`}>{t('usage.partly')}</span> {t('usage.counts')}</h2>
      <div className={s.coverageGrid}>
        <div data-coverage="recorded"><h3>{t('usage.recorded')}</h3>
          <p>{t('usage.recordedBody')}</p></div>
        <div data-coverage="untracked"><h3>{t('usage.untracked')}</h3>
          <ul><li>{t('usage.untracked.chat')}</li><li>{t('usage.untracked.images')}</li><li>{t('usage.untracked.mcp')}</li></ul>
          <p>{t('usage.untrackedNote')}</p></div>
      </div>
    </section>} />;
}
