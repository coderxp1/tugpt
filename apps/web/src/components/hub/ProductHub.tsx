import type { Translator } from '@/i18n/types';
import type { ProductView } from '@/lib/hub/products';
import type { FeatureKey, FeatureState, FeatureStatus } from '@/lib/hub/features';
import { DashboardFrame } from './DashboardFrame';
import { Overview } from './Overview';

export interface ProductHubProps {
  readonly organizationName: string | null;
  readonly fullName?: string | null;
  readonly email: string | null;
  readonly role: string | null;
  /** Raw role key for the frame (owner/admin/…); `role` above is the translated label. */
  readonly roleKey?: string | null;
  readonly features?: Partial<Record<FeatureKey, FeatureState>>;
  /** Full statuses (customer text, actions) from loadOrgFeatures. */
  readonly statuses?: readonly FeatureStatus[];
  readonly products: readonly ProductView[];
  readonly t: Translator;
}
/** Server boundary: passes only session labels and redacted, RLS-scoped metrics. */
export function ProductHub({ organizationName, fullName = null, email, roleKey = null, features, statuses = [], products }: ProductHubProps) {
  const firstName = fullName?.trim().split(/\s+/)[0] || null;
  return <DashboardFrame fullName={fullName} email={email} organizationName={organizationName} role={roleKey} features={features} overview>
    <Overview statuses={statuses} products={products} hasOrganization={organizationName !== null} organizationName={organizationName} firstName={firstName} />
  </DashboardFrame>;
}
