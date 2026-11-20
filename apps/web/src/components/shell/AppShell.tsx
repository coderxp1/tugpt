import type { Translator } from '@/i18n/types';
import type { FeatureKey, FeatureState } from '@/lib/hub/features';
import { DashboardFrame } from '@/components/hub/DashboardFrame';
export interface AppShellProps {
  /** The caller's own active organization (from the session); shown so people know where they are working. */
  readonly organizationName: string | null;
  readonly fullName?: string | null;
  readonly email: string | null;
  readonly role?: string | null;
  readonly features?: Partial<Record<FeatureKey, FeatureState>>;
  readonly t: Translator;
  readonly children: React.ReactNode;
}
/** Same navigation frame as Overview; existing module components and actions remain intact. */
export function AppShell({ fullName = null, email, organizationName, role = null, features, children }: AppShellProps) {
  return <DashboardFrame fullName={fullName} email={email} organizationName={organizationName} role={role} features={features}>{children}</DashboardFrame>;
}
