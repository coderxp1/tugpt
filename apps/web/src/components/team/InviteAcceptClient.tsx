'use client';

import dynamic from 'next/dynamic';

/** The invitation token lives in the URL fragment, which only the browser can read, so this view is client-only. */
export const InviteAcceptClient = dynamic(() => import('./InviteAccept').then((m) => m.InviteAccept), {
  ssr: false,
  loading: () => <p aria-busy="true" style={{ padding: '2rem' }}>Checking your invitation…</p>,
});
