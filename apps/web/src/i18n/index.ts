/**
 * The i18n mechanism. Two locales, two flat dictionaries, no library.
 *
 * next-intl and i18next both solve problems this product does not have —
 * locale-segmented routing, lazy namespace loading, plural rule engines for
 * languages with more than two forms. What they cost is a routing convention
 * and a runtime that every future UI PR has to be written against. ADR-017 has
 * the full reasoning; the short version is that the whole mechanism is this
 * file plus `provider.tsx`, and that is the right size for es + en.
 *
 * Server components call `getDictionary` / `createTranslator` directly. Client
 * components call `useT()` from `./provider`.
 */

import { ORGANIZATION_LOCALES } from '@tugpt/database';
import { es } from './es';
import { en } from './en';
import type {
  Dictionary,
  Locale,
  MessageKey,
  TranslationParams,
  Translator,
} from './types';

export type { Dictionary, Locale, MessageKey, TranslationParams, Translator };
export { ORGANIZATION_LOCALES as SUPPORTED_LOCALES };
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Both dictionaries, eagerly. Together they are a few kilobytes; a dynamic
 * import would buy nothing and would make `getDictionary` async, which would
 * make every caller async, which is a real cost paid for an imaginary one.
 */
const DICTIONARIES: Record<Locale, Dictionary> = {
  es,
  en,
};

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute `{name}` placeholders.
 *
 * A placeholder with no matching param is left in the output verbatim. That is
 * deliberate: `Página {page} de 4` on screen is obviously broken to anyone who
 * looks at it, where silently dropping it produces `Página  de 4`, which reads
 * like a spacing bug and hides the cause. The parity test keeps the two
 * dictionaries from disagreeing about which placeholders a key has.
 */
function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

export function createTranslator(locale: Locale): Translator {
  const dictionary = getDictionary(locale);

  const translate = ((key: MessageKey, params?: TranslationParams): string =>
    interpolate(dictionary[key], params)) as Translator;

  translate.maybe = (key: string, fallback: string, params?: TranslationParams): string => {
    const entry = (dictionary as Record<string, string | undefined>)[key];
    return interpolate(entry ?? fallback, params);
  };

  Object.defineProperty(translate, 'locale', { value: locale, enumerable: true });

  return translate;
}

/**
 * BCP-47 tags for date and number formatting.
 *
 * `es-EC` rather than plain `es`: Ecuador is the launch market and the tag
 * decides the date order a reviewer reads. This formats in the *browser's*
 * timezone, which is not the organization's — `organizations.timezone` and an
 * `org_today()` helper are scheduled for Oct 16, and every date computation
 * moves onto org-local time then. Until then a reviewer in Quito sees Quito
 * time because their laptop is set to it, which is right by accident rather
 * than by construction.
 */
const FORMATTING_LOCALES: Record<Locale, string> = {
  es: 'es-EC',
  en: 'en-US',
};

export function formatDateTime(value: string, locale: Locale): string {
  const parsed = new Date(value);
  // An unparseable timestamp is data worth seeing, not worth replacing with
  // "Invalid Date".
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(FORMATTING_LOCALES[locale]);
}

/** Date only (no time), for "added on" style facts. Unparseable input is returned untouched. */
export function formatDate(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(FORMATTING_LOCALES[locale], { year: 'numeric', month: 'short', day: 'numeric' });
}
