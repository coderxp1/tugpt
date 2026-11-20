/**
 * What this organization can use right now, in customer words.
 *
 * Pure: the server loader (features.server.ts) reads the real gates and passes
 * plain facts in here. Nothing is reported as available unless a gate said so;
 * a gate that could not be read counts as "not enabled", never as available.
 */
import { createTranslator } from '@/i18n';
import type { Translator } from '@/i18n/types';

export type FeatureState = 'available' | 'partial' | 'disabled' | 'not_implemented';

export type FeatureKey =
  | 'chat' | 'team' | 'google' | 'microsoft' | 'mcp' | 'mcp_chat'
  | 'inbox' | 'drafts' | 'knowledge' | 'images' | 'video' | 'media'
  | 'analytics' | 'agents' | 'crm';

export interface FeatureStatus {
  readonly key: FeatureKey;
  readonly name: string;
  readonly href: string | null;
  readonly state: FeatureState;
  /** One customer sentence: what works, or why it does not. */
  readonly detail: string;
}

export type ProviderGate = 'connected' | 'ready' | 'off' | 'unknown';

export interface FeatureFacts {
  /** is_feature_enabled('ai_draft_generation') for the org; null = could not be checked. */
  readonly draftsEnabled: boolean | null;
  readonly google: ProviderGate;
  readonly microsoft: ProviderGate;
  /** TUGPT_CUSTOMER_MCP_ENABLED */
  readonly mcpManage: boolean;
  /** TUGPT_CHAT_MCP_EXECUTION_ENABLED */
  readonly mcpChat: boolean;
  readonly imagesConfigured: boolean;
  readonly hasChatModel: boolean;
}

export const STATE_LABEL: Record<FeatureState, string> = {
  available: 'Available',
  partial: 'Partly available',
  disabled: 'Not enabled',
  not_implemented: 'Not available yet',
};

const EN = createTranslator('en');
export const stateLabel = (st: FeatureState, t: Translator = EN) => t(`feature.state.${st}`);

function provider(name: string, gate: ProviderGate, t: Translator): Pick<FeatureStatus, 'state' | 'detail'> {
  if (gate === 'connected') return { state: 'available', detail: t('feature.provider.connected', { name }) };
  if (gate === 'ready') return { state: 'available', detail: t('feature.provider.ready', { name }) };
  // Same wording as the Connect page: the provider is not offered by TuGPT yet.
  if (gate === 'off') return { state: 'not_implemented', detail: t('feature.provider.off', { name }) };
  return { state: 'disabled', detail: t('feature.provider.unknown', { name }) };
}

export function describeFeatures(f: FeatureFacts, t: Translator = EN): FeatureStatus[] {
  const drafts = f.draftsEnabled === true;
  const n = (key: FeatureKey) => t(`feature.name.${key}`);
  const gated = (key: 'inbox' | 'drafts' | 'knowledge', href: string): FeatureStatus =>
    ({ key, name: n(key), href, state: drafts ? 'available' : 'disabled', detail: drafts ? t(`feature.detail.${key}`) : f.draftsEnabled === null ? t('feature.unchecked') : t('feature.notEnabled') });
  return [
    { key: 'chat', name: n('chat'), href: '/dashboard/chat', state: f.hasChatModel ? 'available' : 'disabled',
      detail: f.hasChatModel ? t('feature.detail.chatOn') : t('feature.detail.chatOff') },
    { key: 'team', name: n('team'), href: '/dashboard/settings#team', state: 'partial', detail: t('feature.detail.team') },
    { key: 'google', name: n('google'), href: '/dashboard/connect', ...provider('Google', f.google, t) },
    { key: 'microsoft', name: n('microsoft'), href: '/dashboard/connect', ...provider('Microsoft 365', f.microsoft, t) },
    { key: 'mcp', name: n('mcp'), href: '/dashboard/connect#mcp-title', state: f.mcpManage ? 'available' : 'disabled',
      detail: f.mcpManage ? t('feature.detail.mcpOn') : t('feature.detail.mcpOff') },
    { key: 'mcp_chat', name: n('mcp_chat'), href: '/dashboard/chat', state: f.mcpChat ? 'available' : 'disabled',
      detail: f.mcpChat ? t('feature.detail.mcpChatOn') : t('feature.detail.mcpChatOff') },
    gated('inbox', '/dashboard/inbox'),
    gated('drafts', '/dashboard/drafts'),
    gated('knowledge', '/dashboard/knowledge'),
    { key: 'images', name: n('images'), href: '/dashboard/create', state: f.imagesConfigured ? 'available' : 'disabled',
      detail: f.imagesConfigured ? t('feature.detail.imagesOn') : t('feature.detail.imagesOff') },
    { key: 'video', name: n('video'), href: '/dashboard/create', state: 'not_implemented', detail: t('feature.detail.notYet') },
    { key: 'media', name: n('media'), href: '/dashboard/media', state: 'disabled', detail: t('feature.detail.media') },
    { key: 'analytics', name: n('analytics'), href: '/dashboard/analytics', state: 'partial', detail: t('feature.detail.analytics') },
    { key: 'agents', name: n('agents'), href: null, state: 'not_implemented', detail: t('feature.detail.notYet') },
    { key: 'crm', name: n('crm'), href: null, state: 'not_implemented', detail: t('feature.detail.notYet') },
  ];
}

export function featureMap(list: readonly FeatureStatus[]): Partial<Record<FeatureKey, FeatureState>> {
  return Object.fromEntries(list.map((f) => [f.key, f.state]));
}

export const isUsable = (s: FeatureState | undefined) => s === 'available' || s === 'partial';
