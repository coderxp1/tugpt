import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import { I18nProvider } from '../../src/i18n/provider';
/** Legacy Spanish-copy regression suites explicitly opt into their fixture locale.
 * The running application is English; this does not override its locale policy. */
export function render(ui: React.ReactNode, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: ({ children }) => <I18nProvider locale="es">{children}</I18nProvider>, ...options });
}
