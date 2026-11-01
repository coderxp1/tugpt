'use client';

// Auth callback page for OAuth redirects.
// Exchanges the code for a session and redirects to the intended destination.

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/browser';
import { useT } from '@/i18n/provider';

function CallbackHandler() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const handleCallback = async () => {
      const supabase = getBrowserClient();
      const code = searchParams.get('code');
      const next = searchParams.get('next') || '/dashboard';

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          router.replace('/auth/login?error=auth_callback_failed');
          return;
        }
      }

      router.replace(next);
      router.refresh();
    };

    handleCallback();
  }, [router, searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-zinc-500">{t('auth.callback.pending')}</p>
    </div>
  );
}

function CallbackFallback() {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-zinc-500">{t('common.loading')}</p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <CallbackHandler />
    </Suspense>
  );
}