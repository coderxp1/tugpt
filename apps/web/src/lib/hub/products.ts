/**
 * The TuGPT product constellation: every product and capability the Dashboard
 * hub can open, in one typed list.
 *
 * WHY A REGISTRY RATHER THAN MARKUP
 *
 * The hub is the place new products will keep arriving — the Workspace next,
 * then channels and capabilities after it. Adding one should be a data change
 * reviewed in one place, not a layout change spread across components. The
 * Workspace phase plugs in by flipping its entry from `planned` to a route.
 *
 * HONESTY RULES (tested in products.test.ts)
 *
 *   * A product without a real, working page has no `href`. The hub renders it
 *     as a non-interactive node; it never links to a placeholder.
 *   * A signal of `null` means "could not be read" and renders as unknown,
 *     never as zero and never as healthy.
 *   * Nothing here decides access. The proxy and each page's own server-side
 *     checks still do; the hub only reflects what the session can already see.
 */

import type { MessageKey } from '@/i18n/types';
import type { HubSignals } from './signals';

export type ProductId =
  | 'conversations'
  | 'drafts'
  | 'knowledge'
  | 'media'
  | 'calendar'
  | 'whatsapp'
  | 'analytics'
  | 'workspace';

export type ProductState =
  /** Working and nothing needs a person. */
  | 'live'
  /** Working and something is waiting on a person. */
  | 'attention'
  /** An external account is linked and healthy. */
  | 'connected'
  /** Available, but needs configuring before it does anything. */
  | 'setup'
  /** Designed, not yet built. Never linked. */
  | 'planned'
  /** The signal could not be read. */
  | 'unknown';

export type ProductGlyph = 'chat' | 'draft' | 'book' | 'film' | 'calendar' | 'phone' | 'chart' | 'spark';

export interface ProductDefinition {
  readonly id: ProductId;
  readonly titleKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly glyph: ProductGlyph;
  /** A real page route, or null when the product has no page yet. */
  readonly href: string | null;
  /**
   * Position on the constellation slab, in percent of its width and height.
   * Two columns flank the core so nodes never overlap it or each other.
   */
  readonly slot: { readonly x: number; readonly y: number };
}

export interface ProductView extends ProductDefinition {
  readonly state: ProductState;
  /** Headline figure, or null when the product has none or it is unreadable. */
  readonly metric: number | null;
  readonly metricKey: MessageKey | null;
  readonly stateKey: MessageKey;
}

export const PRODUCTS: readonly ProductDefinition[] = [
  { id: 'conversations', titleKey: 'hub.product.conversations', descriptionKey: 'hub.product.conversations.desc', glyph: 'chat', href: '/dashboard/inbox', slot: { x: 26, y: 18 } },
  { id: 'drafts', titleKey: 'hub.product.drafts', descriptionKey: 'hub.product.drafts.desc', glyph: 'draft', href: '/dashboard/drafts', slot: { x: 20, y: 39 } },
  { id: 'knowledge', titleKey: 'hub.product.knowledge', descriptionKey: 'hub.product.knowledge.desc', glyph: 'book', href: '/dashboard/knowledge', slot: { x: 20, y: 61 } },
  { id: 'whatsapp', titleKey: 'hub.product.whatsapp', descriptionKey: 'hub.product.whatsapp.desc', glyph: 'phone', href: null, slot: { x: 26, y: 82 } },
  { id: 'media', titleKey: 'hub.product.media', descriptionKey: 'hub.product.media.desc', glyph: 'film', href: '/dashboard/media', slot: { x: 74, y: 18 } },
  { id: 'calendar', titleKey: 'hub.product.calendar', descriptionKey: 'hub.product.calendar.desc', glyph: 'calendar', href: '/settings/integrations', slot: { x: 80, y: 39 } },
  { id: 'analytics', titleKey: 'hub.product.analytics', descriptionKey: 'hub.product.analytics.desc', glyph: 'chart', href: '/dashboard/analytics', slot: { x: 80, y: 61 } },
  { id: 'workspace', titleKey: 'hub.product.workspace', descriptionKey: 'hub.product.workspace.desc', glyph: 'spark', href: null, slot: { x: 74, y: 82 } },
];

const STATE_KEYS: Record<ProductState, MessageKey> = {
  live: 'hub.state.live',
  attention: 'hub.state.attention',
  connected: 'hub.state.connected',
  setup: 'hub.state.setup',
  planned: 'hub.state.planned',
  unknown: 'hub.state.unknown',
};

function resolve(
  id: ProductId,
  s: HubSignals
): { state: ProductState; metric: number | null; metricKey: MessageKey | null } {
  switch (id) {
    case 'conversations':
      if (s.needsHuman === null || s.openConversations === null) return { state: 'unknown', metric: null, metricKey: null };
      return s.needsHuman > 0
        ? { state: 'attention', metric: s.needsHuman, metricKey: 'hub.metric.needsHuman' }
        : { state: 'live', metric: s.openConversations, metricKey: 'hub.metric.open' };
    case 'drafts':
      if (s.draftsAwaitingReview === null) return { state: 'unknown', metric: null, metricKey: null };
      return { state: s.draftsAwaitingReview > 0 ? 'attention' : 'live', metric: s.draftsAwaitingReview, metricKey: 'hub.metric.awaitingReview' };
    case 'knowledge':
      if (s.knowledgeEntries === null) return { state: 'unknown', metric: null, metricKey: null };
      return { state: s.knowledgeEntries > 0 ? 'live' : 'setup', metric: s.knowledgeEntries, metricKey: 'hub.metric.entries' };
    case 'media':
      if (s.activeMediaJobs === null) return { state: 'unknown', metric: null, metricKey: null };
      return { state: 'live', metric: s.activeMediaJobs, metricKey: 'hub.metric.inProgress' };
    case 'calendar':
      switch (s.calendar) {
        case 'connected': return { state: 'connected', metric: null, metricKey: null };
        case 'expired': return { state: 'attention', metric: null, metricKey: null };
        case 'available':
        case 'unconfigured': return { state: 'setup', metric: null, metricKey: null };
        default: return { state: 'unknown', metric: null, metricKey: null };
      }
    case 'whatsapp':
      switch (s.whatsapp) {
        case 'active': return { state: 'connected', metric: null, metricKey: null };
        case 'error': return { state: 'attention', metric: null, metricKey: null };
        case 'pending':
        case 'none': return { state: 'setup', metric: null, metricKey: null };
        default: return { state: 'unknown', metric: null, metricKey: null };
      }
    case 'analytics':
      return { state: 'live', metric: null, metricKey: null };
    case 'workspace':
      return { state: 'planned', metric: null, metricKey: null };
  }
}

export function resolveProducts(signals: HubSignals): ProductView[] {
  return PRODUCTS.map((p) => {
    const r = resolve(p.id, signals);
    return { ...p, ...r, stateKey: STATE_KEYS[r.state] };
  });
}

/** How many products are waiting on a person — the hub's single headline. */
export function attentionCount(products: readonly ProductView[]): number {
  return products.filter((p) => p.state === 'attention').length;
}
