import { redirect } from 'next/navigation';

/**
 * Chat moved to the Workspace (/workspace) in Phase 1 of the Dashboard / Workspace split.
 * This address stays so bookmarks and old links keep working. Temporary (307) on purpose:
 * browsers do not cache it, so the decision stays reversible.
 */
export default function DashboardChatRedirect(): never {
  redirect('/workspace');
}
