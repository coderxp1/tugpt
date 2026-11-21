/**
 * What this organization can use right now, in customer words.
 *
 * Pure: the server loader (features.server.ts) reads the real gates and passes
 * plain facts in here. Nothing is reported as available unless a gate said so.
 * A gate that could not be read is "unknown" (shown as "Couldn't check"), never
 * available. Every state maps to exactly one real signal; see FeatureFacts.
 */
import { createTranslator } from '@/i18n';
import type { Translator } from '@/i18n/types';

/**
 * available        a gate confirmed it works for this organization
 * partial          works, with documented limits (shown as ready, with the limit)
 * setup_required   built and allowed here, but someone has to act first (connect, add)
 * disabled         built, but switched off for this organization or deployment
 * under_review     intentionally held until a separate review is complete
 * not_implemented  not part of TuGPT yet
 * unknown          the gate could not be read
 */
export type FeatureState = 'available' | 'partial' | 'setup_required' | 'disabled' | 'under_review' | 'not_implemented' | 'unknown';

export type FeatureKey =
  | 'chat' | 'library' | 'approvals' | 'custom_agents' | 'images'
  | 'team' | 'analytics' | 'google' | 'microsoft' | 'mcp' | 'mcp_chat'
  | 'inbox' | 'drafts' | 'knowledge' | 'media'
  | 'video' | 'agents' | 'crm';

/** Where the item lives, for grouping in the Overview and the sidebar. */
export type FeatureGroup = 'workspace' | 'organization' | 'messaging' | 'later';

export interface FeatureAction { readonly href: string; readonly label: string }

export interface FeatureStatus {
  readonly key: FeatureKey;
  readonly name: string;
  /** The real page that opens or explains this feature; null when TuGPT has no page for it. */
  readonly href: string | null;
  readonly state: FeatureState;
  readonly group: FeatureGroup;
  /** One customer sentence: what works, or why it does not. */
  readonly detail: string;
  /** The next useful step for THIS person, only when they can take it. */
  readonly action: FeatureAction | null;
  /** Who can enable or set it up, when that is not this person. */
  readonly who: string | null;
}

export type ProviderGate = 'connected' | 'ready' | 'off' | 'unknown';
/** A row-less probe of the table a feature needs: present, absent from this database, or unreadable. */
export type SchemaGate = 'ok' | 'missing' | 'unknown';

export interface FeatureFacts {
  /** is_feature_enabled('ai_draft_generation') for the org; null = could not be checked. */
  readonly draftsEnabled: boolean | null;
  /** list_chat_capabilities rows for the provider (integration_providers.is_available + connection). */
  readonly google: ProviderGate;
  readonly microsoft: ProviderGate;
  /** TUGPT_CUSTOMER_MCP_ENABLED */
  readonly mcpManage: boolean;
  /** At least one MCP capability row in state "connected"; null = could not be read. */
  readonly mcpActive?: boolean | null;
  /** TUGPT_CHAT_MCP_EXECUTION_ENABLED */
  readonly mcpChat: boolean;
  readonly imagesConfigured: boolean;
  readonly hasChatModel: boolean;
  /** chat_threads, knowledge_collections, approval_requests probed under the caller's RLS. */
  readonly workspaceDb?: SchemaGate;
  readonly libraryDb?: SchemaGate;
  readonly approvalsDb?: SchemaGate;
  /** The Workspace's custom-agents build switch (agentsApiAvailable). */
  readonly customAgents?: boolean;
  /** The viewer is an owner or admin of the active organization. */
  readonly canManage?: boolean;
}

export const STATE_LABEL: Record<FeatureState, string> = {
  available: 'Available',
  partial: 'Partly available',
  setup_required: 'Needs setup',
  disabled: 'Not enabled',
  under_review: 'Under review',
  not_implemented: 'Not available yet',
  unknown: 'Couldn’t check',
};

const EN = createTranslator('en');
export const stateLabel = (st: FeatureState, t: Translator = EN) => t(`feature.state.${st}`);

/** Not part of TuGPT yet. Listed by name only; there is no page, action or promise attached. */
export const NOT_YET = ['whatsapp', 'voice', 'meetings', 'research', 'crm', 'catalog', 'workflows', 'developer', 'video', 'booking', 'sources', 'hosting'] as const;
export type NotYetKey = typeof NOT_YET[number];

export function describeFeatures(f: FeatureFacts, t: Translator = EN): FeatureStatus[] {
  const manage = f.canManage === true;
  const n = (key: FeatureKey) => t(`feature.name.${key}`);
  const act = (href: string, label: string): FeatureAction => ({ href, label });
  const ownerOrAdmin = manage ? null : t('feature.who.ownerAdmin');
  /** Switched per organization by TuGPT; owners/admins can request it, members ask them. */
  const tugptOrg = manage ? t('feature.who.tugptRequest') : t('feature.who.askOwner');
  const tugptDeploy = t('feature.who.tugptDeploy');

  const schema = (gate: SchemaGate, key: FeatureKey, href: string, label: string, detailOn: string): FeatureStatus => {
    const base = { key, name: n(key), href, group: 'workspace' as const };
    if (!f.hasChatModel) return { ...base, state: 'disabled', detail: t('feature.detail.chatOff'), action: null, who: tugptDeploy };
    if (gate === 'ok') return { ...base, state: 'available', detail: detailOn, action: act(href, label), who: null };
    if (gate === 'missing') return { ...base, state: 'unknown', detail: t('feature.detail.dbPending'), action: null, who: tugptDeploy };
    return { ...base, state: 'unknown', detail: t('feature.unchecked'), action: null, who: null };
  };

  function provider(key: 'google' | 'microsoft', name: string, gate: ProviderGate): FeatureStatus {
    const href = `/dashboard/connect#provider-${key}`;
    const base = { key, name: n(key), href, group: 'organization' as const };
    if (gate === 'connected') return { ...base, state: 'available', detail: t('feature.provider.connected', { name }), action: act(href, t('feature.action.manage')), who: null };
    if (gate === 'ready') return { ...base, state: 'setup_required', detail: t('feature.provider.ready', { name }), action: manage ? act(href, t('feature.action.connect', { name })) : null, who: ownerOrAdmin };
    if (gate === 'off') return { ...base, state: 'not_implemented', detail: t('feature.provider.off', { name }), action: null, who: null };
    return { ...base, state: 'unknown', detail: t('feature.provider.unknown', { name }), action: null, who: null };
  }

  function mcp(): FeatureStatus {
    const href = '/dashboard/connect#mcp-title';
    const base = { key: 'mcp' as const, name: n('mcp'), href, group: 'organization' as const };
    if (!f.mcpManage) return { ...base, state: 'disabled', detail: t('feature.detail.mcpOff'), action: null, who: tugptDeploy };
    if (f.mcpActive === true) return { ...base, state: 'available', detail: t('feature.detail.mcpOn'), action: act(href, manage ? t('feature.action.manageTools') : t('feature.action.seeTools')), who: null };
    if (f.mcpActive === false) return { ...base, state: 'setup_required', detail: t('feature.detail.mcpSetup'), action: manage ? act(href, t('feature.action.addServer')) : null, who: ownerOrAdmin };
    return { ...base, state: 'unknown', detail: t('feature.unchecked'), action: null, who: null };
  }

  const gated = (key: 'inbox' | 'drafts' | 'knowledge', href: string): FeatureStatus => {
    const base = { key, name: n(key), href, group: 'messaging' as const };
    if (f.draftsEnabled === true) return { ...base, state: 'available', detail: t(`feature.detail.${key}`), action: act(href, t('feature.action.open')), who: null };
    if (f.draftsEnabled === false) return { ...base, state: 'disabled', detail: t('feature.notEnabled'), action: null, who: tugptOrg };
    return { ...base, state: 'unknown', detail: t('feature.unchecked'), action: null, who: null };
  };

  const later = (key: 'video' | 'agents' | 'crm'): FeatureStatus =>
    ({ key, name: n(key), href: null, state: 'not_implemented', group: 'later', detail: t('feature.detail.notYet'), action: null, who: null });

  return [
    schema(f.workspaceDb ?? 'ok', 'chat', '/workspace', t('feature.action.openWorkspace'), t('feature.detail.chatOn')),
    schema(f.libraryDb ?? 'unknown', 'library', '/workspace/library', t('feature.action.openLibrary'), t('feature.detail.library')),
    schema(f.approvalsDb ?? 'unknown', 'approvals', '/workspace/approvals', t('feature.action.review'), t('feature.detail.approvals')),
    f.imagesConfigured
      ? { key: 'images', name: n('images'), href: '/workspace/images', state: 'available', group: 'workspace', detail: t('feature.detail.imagesOn'), action: act('/workspace/images', t('feature.action.createImage')), who: null }
      : { key: 'images', name: n('images'), href: '/workspace/images', state: 'disabled', group: 'workspace', detail: t('feature.detail.imagesOff'), action: null, who: tugptDeploy },
    f.customAgents === true
      ? { key: 'custom_agents', name: n('custom_agents'), href: '/workspace/agents', state: 'available', group: 'workspace', detail: t('feature.detail.customAgentsOn'), action: act('/workspace/agents', t('feature.action.open')), who: null }
      : { key: 'custom_agents', name: n('custom_agents'), href: '/workspace/agents', state: 'under_review', group: 'workspace', detail: t('feature.detail.customAgentsHeld'), action: null, who: null },
    { key: 'team', name: n('team'), href: '/dashboard/settings#members', state: 'partial', group: 'organization', detail: t('feature.detail.team'),
      action: act(manage ? '/dashboard/settings#team' : '/dashboard/settings#members', manage ? t('feature.action.invite') : t('feature.action.seeMembers')), who: null },
    { key: 'analytics', name: n('analytics'), href: '/dashboard/analytics', state: 'partial', group: 'organization', detail: t('feature.detail.analytics'), action: act('/dashboard/analytics', t('feature.action.seeUsage')), who: null },
    provider('google', 'Google', f.google),
    provider('microsoft', 'Microsoft 365', f.microsoft),
    mcp(),
    f.mcpChat
      ? { key: 'mcp_chat', name: n('mcp_chat'), href: '/workspace', state: 'available', group: 'workspace', detail: t('feature.detail.mcpChatOn'), action: null, who: null }
      : { key: 'mcp_chat', name: n('mcp_chat'), href: null, state: 'under_review', group: 'workspace', detail: t('feature.detail.mcpChatOff'), action: null, who: null },
    gated('inbox', '/dashboard/inbox'),
    gated('drafts', '/dashboard/drafts'),
    gated('knowledge', '/dashboard/knowledge'),
    { key: 'media', name: n('media'), href: '/dashboard/media', state: 'under_review', group: 'messaging', detail: t('feature.detail.media'), action: null, who: null },
    later('video'), later('agents'), later('crm'),
  ];
}

export function featureMap(list: readonly FeatureStatus[]): Partial<Record<FeatureKey, FeatureState>> {
  return Object.fromEntries(list.map((f) => [f.key, f.state]));
}

/** The feature's own page may render (it can be used, or it is where the setup happens). */
export const isUsable = (s: FeatureState | undefined) => s === 'available' || s === 'partial' || s === 'setup_required';

/** Overview sections, in order. `partial` counts as ready: it works, with a stated limit. */
export type OverviewSection = 'ready' | 'setup' | 'disabled' | 'review' | 'unknown' | 'later';
export const SECTIONS: readonly OverviewSection[] = ['ready', 'setup', 'disabled', 'review', 'unknown', 'later'];
export function sectionOf(s: FeatureState): OverviewSection {
  switch (s) {
    case 'available': case 'partial': return 'ready';
    case 'setup_required': return 'setup';
    case 'disabled': return 'disabled';
    case 'under_review': return 'review';
    case 'unknown': return 'unknown';
    default: return 'later';
  }
}
