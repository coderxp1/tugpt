import type { Metadata } from "next";
import "./globals.css";
import { APP_CONFIG } from "@/config/locales";
import { createTranslator } from "@/i18n";
import { SessionRenewal } from "@/components/shell/SessionRenewal";
import { I18nProvider } from "@/i18n/provider";
import { getRequestLocale } from "@/i18n/server";

// Read from APP_CONFIG rather than repeating it. Both values lived in two
// places until 2026-08-28, and the copy here is what carried the dead domain
// into the browser tab.
//
// `generateMetadata` rather than a static `metadata` export as of 2026-08-30:
// the description is a translated sentence, so it depends on the request's
// locale. `getRequestLocale` is wrapped in React `cache()`, so this and the
// layout below resolve the organization once between them, not twice.
export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getRequestLocale());
  return {
    title: APP_CONFIG.name,
    description: t("app.description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // `lang` is set here rather than hardcoded because it is what a screen reader
  // switches voice on and what a browser offers to translate from. Getting it
  // wrong is not cosmetic for the reviewer who depends on it.
  //
  // KNOWN COST, accepted: `getRequestLocale` reads cookies, and a Request-time
  // API in the root layout opts every route into dynamic rendering. In practice
  // that changes `/auth/*` only — everything else is behind the proxy's auth
  // check and was already dynamic — and this app is served by a Node container,
  // not a CDN. The alternative was resolving locale in a dashboard-only layout,
  // which cannot set `<html lang>` and would have left the attribute lying.
  const locale = await getRequestLocale();

  return (
    <html lang={locale}>
      <body className="min-h-screen flex flex-col antialiased">
        <I18nProvider locale={locale}><SessionRenewal />{children}</I18nProvider>
      </body>
    </html>
  );
}
