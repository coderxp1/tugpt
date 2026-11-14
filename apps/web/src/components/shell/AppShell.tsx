import type { Translator } from '@/i18n/types';
import { DashboardFrame } from '@/components/hub/DashboardFrame';
export interface AppShellProps {
  readonly organizationName: string | null;
  readonly email: string | null;
  readonly role?: string | null;
  readonly t: Translator;
  readonly children: React.ReactNode;
}
/** Same navigation frame as Overview; existing module components and actions remain intact. */
export function AppShell({ organizationName, email, role = null, children }: AppShellProps) {
  return <DashboardFrame organizationName={organizationName} email={email} role={role}>{children}</DashboardFrame>;
}
