import { cache } from 'react';
import { cookies } from 'next/headers';
import { parseLocalePreference, LOCALE_COOKIE } from './index';
import type { Locale } from './types';

/**
 * The Dashboard language is a per-person browser preference (the
 * `tugpt_locale` cookie set from Settings → Language). English is the default;
 * the stored organization locale is deliberately NOT used, so nobody's
 * interface changes language without choosing it. No database change.
 */
export const getRequestLocale = cache(async (): Promise<Locale> => {
  try {
    return parseLocalePreference((await cookies()).get(LOCALE_COOKIE)?.value);
  } catch {
    return 'en';
  }
});
