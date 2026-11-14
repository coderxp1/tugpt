/** Held integration entry point: no provider/vault/status reads or OAuth actions. */
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';

export default async function IntegrationsPage() {
  const t = createTranslator(await getRequestLocale());
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900">{t('integrations.title')}</h1>
      <section className="flex flex-col gap-4 rounded border border-zinc-200 p-6">
        <h2 className="text-lg font-medium text-zinc-800">{t('hub.state.held')}</h2>
        <p className="text-zinc-600">{t('integrations.reconciliationHold')}</p>
      </section>
    </div>
  );
}
