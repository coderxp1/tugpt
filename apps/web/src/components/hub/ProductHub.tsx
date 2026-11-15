import type { Translator } from '@/i18n/types';
import type { ProductView } from '@/lib/hub/products';
import { DashboardFrame } from './DashboardFrame';
import { Overview } from './Overview';

export interface ProductHubProps {
  readonly organizationName: string | null;
  readonly fullName?: string | null;
  readonly email: string | null;
  readonly role: string | null;
  readonly products: readonly ProductView[];
  readonly t: Translator;
}
/** Server boundary: passes only session labels and redacted, RLS-scoped metrics. */
export function ProductHub({ organizationName, fullName = null, email, products }: ProductHubProps) {
  return <DashboardFrame fullName={fullName} email={email} overview>
    <Overview products={products} hasOrganization={organizationName !== null} />
  </DashboardFrame>;
}
