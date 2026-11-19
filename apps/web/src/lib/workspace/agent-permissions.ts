import type { CustomAgent } from '@/lib/workspace-data/contracts';

/** UI hints only. API and RLS remain authoritative; missing permissions fail closed. */
export function agentPermissions(role: string | undefined, agent?: Pick<CustomAgent, 'ownedByMe' | 'canEdit' | 'canDelete'>) {
  const writer = role === 'owner' || role === 'admin' || role === 'member';
  return {
    create: writer,
    share: role === 'owner' || role === 'admin',
    edit: writer && agent?.ownedByMe === true && agent.canEdit === true,
    delete: writer && agent?.canDelete === true,
  };
}
