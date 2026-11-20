import type { Metadata } from 'next';
import { InviteAcceptClient } from '@/components/team/InviteAcceptClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Join an organization · TuGPT',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function InvitePage() {
  return <main id="main"><InviteAcceptClient /></main>;
}
