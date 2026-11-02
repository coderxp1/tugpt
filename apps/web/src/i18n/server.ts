import { cache } from 'react';
import type { Locale } from './types';
/** Dashboard review is English-only. Preserve stored organization locales and
 * customer content; multilingual UI selection is deferred, not a DB migration. */
export const getRequestLocale = cache(async (): Promise<Locale> => 'en');
