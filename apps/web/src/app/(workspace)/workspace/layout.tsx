/**
 * The Workspace: where people work with AI (chat today; library, agents, workflows, meetings later).
 * Same origin, session cookie, organization, permissions and /api/v1 backend as the Dashboard;
 * a separate route group and frame. The proxy protects /workspace like every unlisted path.
 */
import { cookies } from 'next/headers';
import { I18nProvider } from '@/i18n/provider';
import { redirect } from 'next/navigation';
import { getSessionContext } from '@/lib/tenant/server';
import { initialThreads } from '@/lib/chat/initial-threads';
import { canApproveMcpCalls } from '@/lib/tenant/roles';
import { AccessRequired } from '@/components/shell/AccessRequired';
import { ThreadsProvider } from '@/components/workspace/ThreadsProvider';
import { WorkspaceFrame } from '@/components/workspace/WorkspaceFrame';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getSessionContext();
  if (!session) redirect('/auth/login');
  if (!session.tenant) return <AccessRequired />;
  const threads = await initialThreads();
  const locale = (await cookies()).get('tugpt_workspace_locale')?.value === 'es' ? 'es' : 'en';
  return (
    <I18nProvider locale={locale}><ThreadsProvider initialThreads={threads}>
      <WorkspaceFrame fullName={session.fullName ?? null} email={session.email || null} canDecide={canApproveMcpCalls(session)}>{children}</WorkspaceFrame>
    </ThreadsProvider></I18nProvider>
  );
}
