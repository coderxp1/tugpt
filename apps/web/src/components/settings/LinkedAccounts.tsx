'use client';

/**
 * The account screen: one canonical TuGPT identity, the provider identities
 * explicitly linked to it, and a deliberate way to add another.
 *
 * WHY THIS COMPONENT EXISTS AT ALL
 *
 * Signing in with GitHub and then with Google creates two Supabase users
 * unless the person deliberately links the second to the first. Email-based
 * auto-matching would hide that — and it is exactly what the owner's identity
 * rules forbid, because it lets whoever controls an email address absorb an
 * account. So the product has to say, on screen, which identities are one
 * person, and make linking an action rather than an inference.
 *
 * `linkIdentity` is the only write path here. It is a browser redirect to the
 * provider: the session survives, and Supabase attaches the new subject to the
 * *existing* user rather than creating another. Unlinking is deliberately not
 * offered yet — it is a destructive action that needs its own confirmation and
 * a last-identity guard, and a half-built version of it is worse than none.
 */

import { useState } from 'react';
import { createTranslator, formatDateTime } from '@/i18n';
import type { Locale } from '@/i18n/types';
import { getBrowserClient } from '@/lib/supabase/browser';
import {
  linkableProviders,
  type LinkedIdentity,
  type LinkableProvider,
} from '@/lib/auth/identities';

export interface LinkedAccountsProps {
  /** The workspace-relative locale, resolved on the server from the org. */
  readonly locale: Locale;
  /**
   * Supabase's canonical user id. Shown verbatim because it is the thing that
   * must stay the same across both provider journeys — a person verifying SSO
   * needs to read it, not trust a sentence about it.
   */
  readonly canonicalUserId: string;
  readonly email: string | null;
  readonly identities: readonly LinkedIdentity[];
  /** Current path, so the provider returns the person here afterwards. */
  readonly returnTo: string;
}

export function LinkedAccounts({
  locale,
  canonicalUserId,
  email,
  identities,
  returnTo,
}: LinkedAccountsProps) {
  const t = createTranslator(locale);
  const [linking, setLinking] = useState<LinkableProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const missing = linkableProviders(identities);

  const link = async (provider: LinkableProvider) => {
    setLinking(provider);
    setError(null);

    try {
      const supabase = getBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(
        returnTo
      )}`;

      const { error: linkError } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo },
      });

      if (linkError) {
        setError(t('accounts.linkFailed'));
        return;
      }

      // On success the browser leaves for the provider. Nothing after this
      // point runs in the page being replaced, so there is no state to update:
      // the person comes back to a freshly rendered server component that
      // reads the new identity list from Supabase.
    } catch {
      setError(t('accounts.linkFailed'));
    } finally {
      setLinking(null);
    }
  };

  return (
    <section className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-xl font-bold text-zinc-900">{t('accounts.title')}</h1>
      <p className="mt-1 text-sm text-zinc-600">{t('accounts.subtitle')}</p>

      <dl className="mt-6 rounded-lg border border-zinc-200 bg-white p-4">
        <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {t('accounts.canonicalId')}
        </dt>
        <dd className="mt-1 break-all font-mono text-sm text-zinc-800">{canonicalUserId}</dd>
        {email ? (
          <dd className="mt-1 text-sm text-zinc-600">{email}</dd>
        ) : null}
        <p className="mt-2 text-xs text-zinc-500">{t('accounts.canonicalHint')}</p>
      </dl>

      <h2 className="mt-8 text-base font-semibold text-zinc-900">
        {t('accounts.linkedHeading')}
      </h2>

      {identities.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600">{t('accounts.noneLinked')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
          {identities.map((identity) => (
            <li key={identity.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900">
                  {t(identity.labelKey)}
                  <span className="ml-2 rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    {t('accounts.linked')}
                  </span>
                </p>
                {identity.email ? (
                  <p className="truncate text-sm text-zinc-600">{identity.email}</p>
                ) : null}
              </div>
              {identity.lastSignInAt ? (
                <p className="text-xs text-zinc-500">
                  {t('accounts.lastSignIn', {
                    at: formatDateTime(identity.lastSignInAt, locale),
                  })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {missing.length > 0 ? (
        <div className="mt-6">
          <h2 className="text-base font-semibold text-zinc-900">
            {t('accounts.linkHeading')}
          </h2>
          <p className="mt-1 text-sm text-zinc-600">{t('accounts.linkHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {missing.map((provider) => (
              <button
                key={provider}
                type="button"
                disabled={linking !== null}
                onClick={() => void link(provider)}
                className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50"
              >
                {linking === provider
                  ? t('accounts.linking')
                  : t('accounts.link', { provider: t(`accounts.provider.${provider}`) })}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-8 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        {t('accounts.noAutoMerge')}
      </p>
    </section>
  );
}
