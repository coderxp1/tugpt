import { ORGANIZATION_LOCALES } from '@tugpt/database';
import type { OrganizationLocale } from '@tugpt/database';
// UI language policy; deliberately separate from the database's organization locale.
export const APP_CONFIG = {
  name: 'TuGPT',
  primaryLocale: 'en' as OrganizationLocale,
  secondaryLocale: 'es' as OrganizationLocale,
  supportedLocales: ORGANIZATION_LOCALES,
};
export type SupportedLocale = OrganizationLocale;
