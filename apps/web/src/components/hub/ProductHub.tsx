import type { Translator } from '@/i18n/types';
import type { ProductView } from '@/lib/hub/products';
import { DashboardFrame } from './DashboardFrame';
import { Overview } from './Overview';

export interface ProductHubProps {
  readonly organizationName: string | null;
  readonly email: string | null;
  readonly role: string | null;
  readonly products: readonly ProductView[];
  readonly t: Translator;
}
/** Server boundary: passes only session labels and redacted, RLS-scoped metrics. */
export function ProductHub({ organizationName, email, role, products }: ProductHubProps) {
  return <DashboardFrame organizationName={organizationName} email={email} role={role} overview>
    <Overview products={products} hasOrganization={organizationName !== null} />
  </DashboardFrame>;
}
