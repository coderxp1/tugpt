/**
 * The frame every dashboard page renders inside.
 *
 * A server component. Only `PrimaryNav` is a client component, because only
 * the active-item highlight needs the current path — the organization name and
 * the reviewer's email are read on the server and rendered there.
 *
 * WHY THE ORGANIZATION NAME IS IN THE HEADER
 *
 * TuGPT is multi-tenant and the drafts on screen are replies that will be sent
 * as a business, to that business's customers. A reviewer who cannot see whose
 * inbox they are approving from is one org-switch away from sending a bakery's
 * prices to a hardware store's customer. It is not decoration.
 */

import Link from 'next/link';
import { APP_CONFIG } from '@/config/locales';
import { PrimaryNav } from './PrimaryNav';
import type { Translator } from '@/i18n/types';

export interface AppShellProps {
  /** Null when the session could not be resolved, or the user has no org. */
  readonly organizationName: string | null;
  /** Null when the session could not be resolved. May be empty for some providers. */
  readonly email: string | null;
  readonly t: Translator;
  readonly children: React.ReactNode;
}

export function AppShell({ organizationName, email, t, children }: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      {/*
        First focusable element on the page. A reviewer working by keyboard
        would otherwise tab through the whole header on every navigation to
        reach the draft they came to read.
      */}
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-zinc-900 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        {t('shell.skipToContent')}
      </a>

      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-2">
            {/*
              Back to the Dashboard hub. The hub is where products are chosen;
              this header is inside one of them.
            */}
            <Link
              href="/dashboard"
              aria-label={t('hub.home')}
              className="text-sm font-bold text-zinc-900 hover:underline"
            >
              {APP_CONFIG.name}
            </Link>
            {/*
              The separator is decorative and hidden from assistive technology;
              the organization name carries its own label instead, so it is not
              read as a bare fragment after the product name.
            */}
            <span aria-hidden="true" className="text-zinc-300">
              /
            </span>
            <span className="truncate text-sm text-zinc-600">
              <span className="sr-only">{t('shell.organizationLabel')}: </span>
              {organizationName ?? t('shell.organizationUnknown')}
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-3 text-sm">
            {email ? <span className="truncate text-zinc-500">{email}</span> : null}
            <Link
              href="/auth/logout"
              // Not speculatively fetched. Today signing out happens in a
              // browser effect on that page, so a prefetch is harmless — but
              // the day it becomes a route handler or a server action,
              // prefetching would sign people out by hovering the link, and
              // that change would have no reason to come back and edit this
              // file. A destructive destination is not one to warm up.
              //
              // It stays a link rather than a form POST, which is what a
              // destructive action really wants. Turning `/auth/logout` into
              // an action is a separate change; what this fixes today is that
              // signing out required typing the URL.
              prefetch={false}
              className="whitespace-nowrap rounded border border-zinc-300 px-3 py-1 font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              {t('shell.signOut')}
            </Link>
          </div>
        </div>
      </header>

      <PrimaryNav />

      <main id="contenido" className="flex-1">
        {children}
      </main>
    </div>
  );
}
