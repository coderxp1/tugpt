import { customerModels } from '@/lib/workspace/assistant-capabilities';
import { getSessionContext } from '@/lib/tenant/server';
import type { Metadata } from 'next';
import { configuredModels, publicModels } from '@/lib/chat/models';
import { AgentsView } from '@/components/workspace/AgentsView';

export const metadata: Metadata = { title: 'Agents · TuGPT Workspace' };

/**
 * Agents. The model list is the public chat catalogue (names only, never keys or secrets). Custom
 * agents are loaded in the browser from GET /api/v1/agents (contract C-1) once it exists.
 */
export default async function AgentsPage() {
  const session = await getSessionContext().catch(() => null);
  const role = session && !session.requestedTenantRejected ? session.tenant?.role : undefined;
  return <AgentsView role={role} models={customerModels(publicModels(configuredModels()))} />;
}
