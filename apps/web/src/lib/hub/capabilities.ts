import type { ProductView, ProductGlyph, ProductId } from './products';

/** The official Blueprint's fourteen areas, not a claim that all are shipped. */
export const BLUEPRINT_AREAS = [
  'Core Workspace', 'CRM Hub', 'Messaging Center', 'TuGPT MCP Layer',
  'Research & Search', 'Custom AI Agents', 'Knowledge & Integrations',
  'Workflow Automation', 'Developer Platform', 'Administration & Governance',
  'Privacy & Deployment', 'Live Voice Assistants', 'Video Generation', 'WhatsApp Business Suite',
] as const;
export type BlueprintArea = typeof BLUEPRINT_AREAS[number];
export type Group = 'Connect' | 'Create' | 'Operate';
export const GROUPS: readonly { name: Group; sub: string }[] = [
  { name: 'Connect', sub: 'Make every conversation count.' },
  { name: 'Create', sub: 'Turn ideas into useful work.' },
  { name: 'Operate', sub: 'Keep your business in motion.' },
];
export interface Capability {
  id: string; title: string; description: string; group: Group; glyph: ProductGlyph;
  area: BlueprintArea; product?: ProductId; note?: string;
}
/** Only a backing ProductView may supply a route. Planned capabilities never fabricate destinations. */
export const CAPABILITIES: readonly Capability[] = [
  { id: 'whatsapp', title: 'WhatsApp AI Assistants', description: 'Support, qualify leads and collaborate.', group: 'Connect', glyph: 'phone', area: 'WhatsApp Business Suite', product: 'whatsapp', note: 'Channel integration and webhook operations are on hold; existing conversation review remains separate.' },
  { id: 'conversations', title: 'Conversations', description: 'Shared inbox, ownership and human takeover.', group: 'Connect', glyph: 'chat', area: 'Messaging Center', product: 'conversations' },
  { id: 'voice', title: 'Voice Intelligence', description: 'Real-time voice conversations.', group: 'Connect', glyph: 'phone', area: 'Live Voice Assistants', note: 'Voice assistants are not available yet.' },
  { id: 'meetings', title: 'Meeting Intelligence', description: 'Meeting insights and follow-up work.', group: 'Connect', glyph: 'film', area: 'Research & Search', note: 'Meeting analysis is not available yet.' },
  { id: 'crm', title: 'CRM Hub', description: 'Customer records, Zoho, Odoo and Salesforce.', group: 'Connect', glyph: 'chat', area: 'CRM Hub', note: 'CRM management and connectors are not available yet.' },
  { id: 'mcp', title: 'TuGPT MCP Layer', description: 'Approved tools and enterprise systems.', group: 'Connect', glyph: 'spark', area: 'TuGPT MCP Layer', note: 'Customer MCP connections are not available yet.' },
  { id: 'drafts', title: 'AI Drafts', description: 'Review, edit and approve AI-assisted replies.', group: 'Create', glyph: 'draft', area: 'Workflow Automation', product: 'drafts' },
  { id: 'knowledge', title: 'Knowledge & Integrations', description: 'Give your AI approved company context.', group: 'Create', glyph: 'book', area: 'Knowledge & Integrations', product: 'knowledge', note: 'FAQ management requires the organization feature flag. Document connectors are not yet available.' },
  { id: 'media', title: 'Media Studio', description: 'Manage media jobs and their results.', group: 'Create', glyph: 'film', area: 'Video Generation', product: 'media', note: 'Media operations are on hold pending separate security review, regardless of feature flags.' },
  { id: 'workspace', title: 'Chat', description: 'Private AI chat with your apps and knowledge.', group: 'Create', glyph: 'chat', area: 'Core Workspace', product: 'workspace' },
  { id: 'research', title: 'Research & Search', description: 'Source-based research and document analysis.', group: 'Create', glyph: 'book', area: 'Research & Search', note: 'Research and document analysis are not available yet.' },
  { id: 'agents', title: 'Custom AI Agents', description: 'Reusable assistants with knowledge and tools.', group: 'Create', glyph: 'spark', area: 'Custom AI Agents', note: 'The agent and workflow builder is not available yet.' },
  { id: 'calendar', title: 'Calendar & Booking', description: 'Bring scheduling closer to your team.', group: 'Operate', glyph: 'calendar', area: 'Workflow Automation', product: 'calendar', note: 'Integration connection, status and booking operations are on hold pending separate security review.' },
  { id: 'catalog', title: 'Catalog', description: 'Your products and services, organized.', group: 'Operate', glyph: 'book', area: 'CRM Hub', note: 'Catalog management is not available yet.' },
  { id: 'analytics', title: 'Usage & Costs', description: 'Understand your organization’s AI activity.', group: 'Operate', glyph: 'chart', area: 'Administration & Governance', product: 'analytics' },
  { id: 'workflows', title: 'Workflow Automation', description: 'Multi-step processes and human approvals.', group: 'Operate', glyph: 'draft', area: 'Workflow Automation', note: 'Draft review is available above when enabled for your organization. The workflow builder is not yet available.' },
  { id: 'developer', title: 'Developer Platform', description: 'APIs for agents, knowledge and integrations.', group: 'Operate', glyph: 'spark', area: 'Developer Platform', note: 'Internal application APIs exist. Developer self-service is not available yet.' },
  { id: 'governance', title: 'Administration & Governance', description: 'Permissions, policies and oversight.', group: 'Operate', glyph: 'book', area: 'Administration & Governance', note: 'Organization permissions are enforced. The administration console is not yet available.' },
  { id: 'privacy', title: 'Privacy & Deployment', description: 'Secure adoption and deployment choices.', group: 'Operate', glyph: 'book', area: 'Privacy & Deployment', note: 'Deployment management is not available in this Dashboard.' },
];
export function capabilityViews(products: readonly ProductView[]) {
  return CAPABILITIES.map(c => ({ ...c, productView: products.find(p => p.id === c.product) ?? null }));
}
