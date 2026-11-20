import type { CustomAgent } from '@/lib/workspace-data/contracts';

/** UI hints only. API and RLS remain authoritative; missing permissions fail closed. */
export function agentPermissions(role: string | undefined, agent?: Pick<CustomAgent, 'ownedByMe' | 'canEdit' | 'canDelete'>) {
  // AuthService OrganizationRole + agents_insert RLS: every known non-viewer
  // may create private agents. Do not treat unknown roles (including member) as writers.
  const writer = role === 'owner' || role === 'admin' || role === 'manager' || role === 'agent';
  return {
    create: writer,
    share: role === 'owner' || role === 'admin',
    edit: writer && agent?.ownedByMe === true && agent.canEdit === true,
    delete: writer && agent?.canDelete === true,
  };
}
