/**
 * What this organization can use right now, in customer words.
 *
 * Pure: the server loader (features.server.ts) reads the real gates and passes
 * plain facts in here. Nothing is reported as available unless a gate said so;
 * a gate that could not be read counts as "not enabled", never as available.
 */
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

const NOT_ENABLED = 'Not enabled for your organization. TuGPT switches it on per organization; it cannot be turned on from the Dashboard yet.';

function provider(name: string, gate: ProviderGate): Pick<FeatureStatus, 'state' | 'detail'> {
  if (gate === 'connected') return { state: 'available', detail: `${name} is connected. Type @ in Chat to use it.` };
  if (gate === 'ready') return { state: 'available', detail: `Ready to connect. An owner or admin can connect ${name} on the Connect page.` };
  // Same wording as the Connect page: the provider is not offered by TuGPT yet.
  if (gate === 'off') return { state: 'not_implemented', detail: `Connecting ${name} is not switched on for TuGPT yet. Nothing is connected.` };
  return { state: 'disabled', detail: `The ${name} connection status could not be checked, so it is shown as not enabled.` };
}

export function describeFeatures(f: FeatureFacts): FeatureStatus[] {
  const drafts = f.draftsEnabled === true;
  const gated = (key: FeatureKey, name: string, href: string, on: string): FeatureStatus =>
    ({ key, name, href, state: drafts ? 'available' : 'disabled', detail: drafts ? on : f.draftsEnabled === null ? 'Its status could not be checked, so it is shown as not enabled.' : NOT_ENABLED });
  return [
    { key: 'chat', name: 'Chat', href: '/dashboard/chat', state: f.hasChatModel ? 'available' : 'disabled',
      detail: f.hasChatModel ? 'Chat with TuGPT’s private AI model. Your chats are kept per organization.' : 'No AI model is set up for your organization yet.' },
    { key: 'team', name: 'Team & invitations', href: '/dashboard/settings#team', state: 'partial',
      detail: 'Invite colleagues, manage invitations and see who is a member. Changing roles and removing members is not available yet.' },
    { key: 'google', name: 'Google Workspace', href: '/dashboard/connect', ...provider('Google', f.google) },
    { key: 'microsoft', name: 'Microsoft 365', href: '/dashboard/connect', ...provider('Microsoft 365', f.microsoft) },
    { key: 'mcp', name: 'Your own tools (MCP servers)', href: '/dashboard/connect#mcp-title', state: f.mcpManage ? 'available' : 'disabled',
      detail: f.mcpManage ? 'Owners and admins can add a server, review its tools and switch it on.' : 'Adding and switching on MCP servers is not enabled yet. Existing servers can still be turned off or removed.' },
    { key: 'mcp_chat', name: 'MCP tools in Chat', href: '/dashboard/chat', state: f.mcpChat ? 'available' : 'disabled',
      detail: f.mcpChat ? 'Approved, active MCP tools can be used in Chat with @.' : 'Approved MCP tools cannot be used in Chat yet. Chat never calls them until this is switched on.' },
    gated('inbox', 'Conversations', '/dashboard/inbox', 'See customer conversations that are waiting for your team.'),
    gated('drafts', 'AI Drafts', '/dashboard/drafts', 'Review, edit and approve replies drafted by TuGPT.'),
    gated('knowledge', 'Knowledge', '/dashboard/knowledge', 'Maintain the facts TuGPT uses when drafting replies.'),
    { key: 'images', name: 'Image generation', href: '/dashboard/create', state: f.imagesConfigured ? 'available' : 'disabled',
      detail: f.imagesConfigured ? 'Generate images on TuGPT’s own EU GPU.' : 'Image generation is not set up for your organization yet.' },
    { key: 'video', name: 'Video generation', href: '/dashboard/create', state: 'not_implemented', detail: 'Not part of TuGPT yet.' },
    { key: 'media', name: 'Media Studio', href: '/dashboard/media', state: 'disabled',
      detail: 'On hold during a security review. Nothing can be generated or uploaded until the review is complete.' },
    { key: 'analytics', name: 'Usage & Costs', href: '/dashboard/analytics', state: 'partial',
      detail: 'Shows recorded usage. Chat messages are not counted yet, so totals can read 0 even when your team uses Chat.' },
    { key: 'agents', name: 'Agents & workflows', href: null, state: 'not_implemented', detail: 'Not part of TuGPT yet.' },
    { key: 'crm', name: 'CRM integration', href: null, state: 'not_implemented', detail: 'Not part of TuGPT yet.' },
  ];
}

export function featureMap(list: readonly FeatureStatus[]): Partial<Record<FeatureKey, FeatureState>> {
  return Object.fromEntries(list.map((f) => [f.key, f.state]));
}

export const isUsable = (s: FeatureState | undefined) => s === 'available' || s === 'partial';
