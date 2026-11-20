import type { Translator } from '@/i18n/types';

/** Role keys stored in organization_members.role, lowest to highest. */
export const ROLES = ['viewer', 'agent', 'manager', 'admin', 'owner'] as const;

/** The one place a role is named, so the sidebar, Overview and Settings always agree. */
export function roleLabel(role: string, t: Translator): string {
  return t.maybe(`hub.role.${role}`, role);
}

export const canManageOrg = (role: string | null | undefined) => role === 'owner' || role === 'admin';
