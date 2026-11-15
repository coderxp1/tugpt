import type { Translator } from '@/i18n/types';
import { DashboardFrame } from '@/components/hub/DashboardFrame';
export interface AppShellProps {
  /** Kept for the session boundary; not rendered in the frame. */
  readonly organizationName: string | null;
  readonly fullName?: string | null;
  readonly email: string | null;
  readonly role?: string | null;
  readonly t: Translator;
  readonly children: React.ReactNode;
}
/** Same navigation frame as Overview; existing module components and actions remain intact. */
export function AppShell({ fullName = null, email, children }: AppShellProps) {
  return <DashboardFrame fullName={fullName} email={email}>{children}</DashboardFrame>;
}
