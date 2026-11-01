import { describe, expect, it } from 'vitest';
import { generateMetadata } from '../src/app/layout';
import { APP_CONFIG } from '../src/config/locales';
import { es } from '../src/i18n/es';

describe('TuGPT Product Identity & Localization Config', () => {
  it('has the correct product name and identity metadata', async () => {
    // No TLD in the product name. The old domain was lost on 2026-08-28 and
    // the brand had carried it into the browser tab; dashboard.tugpt.pro is a hostname,
    // not an identity. apps/worker/tests/no-dead-domain.test.ts keeps the dead
    // one from returning — including from a comment like this one.
    expect(APP_CONFIG.name).toBe('TuGPT');
    expect((await generateMetadata()).title).toBe('TuGPT');
  });

  it('describes the product in Spanish outside a request context', async () => {
    // `generateMetadata` resolves the organization's locale, and there is no
    // request here to resolve one from. That path has to end in Spanish rather
    // than in a thrown error: it is also the path taken when Supabase is
    // unreachable, and a language lookup must not be able to 500 the layout.
    expect((await generateMetadata()).description).toBe(es['app.description']);
  });

  it('configures Spanish as the primary default language', () => {
    expect(APP_CONFIG.primaryLocale).toBe('es');
  });

  it('supports Spanish as primary and English as secondary language', () => {
    expect(APP_CONFIG.supportedLocales).toContain('es');
    expect(APP_CONFIG.supportedLocales).toContain('en');
    expect(APP_CONFIG.secondaryLocale).toBe('en');
  });
});
