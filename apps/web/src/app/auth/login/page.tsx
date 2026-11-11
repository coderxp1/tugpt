'use client';

// Login page using @supabase/ssr browser client.
// Stores session in cookies (not localStorage) so the server can read it.

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/browser';
import { APP_CONFIG } from '@/config/locales';
import { useT } from '@/i18n/provider';

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirect = searchParams.get('redirect') || '/dashboard/drafts';

  useEffect(() => {
    // If already authenticated, redirect
    const checkSession = async () => {
      const supabase = getBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        router.replace(redirect);
      }
    };
    checkSession();
  }, [router, redirect]);

  /**
   * OAuth entry points.
   *
   * GitHub is the provider the SSO journey starts from; Google is offered
   * here as well because a person who has already linked it should not have
   * to remember which button they used first. Both come back through
   * /auth/callback, which exchanges the code for a session.
   *
   * A failure leaves `loading` true only until the finally block runs: on
   * success the browser navigates away, and there is no page left to reset.
   */
  const signInWith = async (provider: 'github' | 'google') => {
    setLoading(true);
    setError(null);

    try {
      const supabase = getBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(
        redirect
      )}`;

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });

      if (oauthError) setError(oauthError.message);
    } catch {
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = getBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setError(error.message);
        return;
      }

      router.replace(redirect);
      router.refresh();
    } catch {
      // Supabase's own auth errors (`error.message` above) stay in the
      // language Supabase sends. They are the provider's text, not ours, and
      // translating them here would mean maintaining a mapping of somebody
      // else's strings. This one is ours.
      setError(t('errors.INTERNAL_ERROR'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-2xl font-bold text-zinc-900">
          {t('auth.login.title', { app: APP_CONFIG.name })}
        </h1>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void signInWith('github')}
            className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50"
          >
            {t('auth.login.github')}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void signInWith('google')}
            className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50"
          >
            {t('auth.login.google')}
          </button>
        </div>

        <div className="my-4 flex items-center gap-2 text-xs text-zinc-400">
          <span aria-hidden="true" className="h-px flex-1 bg-zinc-200" />
          <span>{t('auth.login.or')}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-zinc-200" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-zinc-700">
              {t('auth.login.email')}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-300 p-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder={t('auth.login.emailPlaceholder')}
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-zinc-700">
              {t('auth.login.password')}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-300 p-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder={t('auth.login.passwordPlaceholder')}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {loading ? t('auth.login.submitting') : t('auth.login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}

function LoginFallback() {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <p className="text-zinc-500">{t('common.loading')}</p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}