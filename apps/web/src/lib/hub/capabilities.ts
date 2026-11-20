import type { ProductView, ProductGlyph, ProductId } from './products';
import type { FeatureKey } from './features';
import { createTranslator } from '@/i18n';
import type { Translator } from '@/i18n/types';

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
  /** Organization feature that gates this card (same source as the sidebar and Settings). */
  feature?: FeatureKey;
  /** Destination for feature-backed cards without a product view; used only while the feature is usable. */
  href?: string;
}
/** Only a backing ProductView, or a usable organization feature, may supply a route. Planned capabilities never fabricate destinations. */
export const CAPABILITIES: readonly Capability[] = [
  { id: 'whatsapp', title: 'WhatsApp AI Assistants', description: 'Support, qualify leads and collaborate.', group: 'Connect', glyph: 'phone', area: 'WhatsApp Business Suite', product: 'whatsapp' },
  { id: 'conversations', title: 'Conversations', description: 'Shared inbox, ownership and human takeover.', group: 'Connect', glyph: 'chat', area: 'Messaging Center', product: 'conversations', feature: 'inbox' },
  { id: 'voice', title: 'Voice Intelligence', description: 'Real-time voice conversations.', group: 'Connect', glyph: 'phone', area: 'Live Voice Assistants' },
  { id: 'meetings', title: 'Meeting Intelligence', description: 'Meeting insights and follow-up work.', group: 'Connect', glyph: 'film', area: 'Research & Search' },
  { id: 'crm', title: 'CRM Hub', description: 'Customer records, Zoho, Odoo and Salesforce.', group: 'Connect', glyph: 'chat', area: 'CRM Hub', feature: 'crm' },
  { id: 'mcp', title: 'TuGPT MCP Layer', description: 'Approved tools and enterprise systems.', group: 'Connect', glyph: 'spark', area: 'TuGPT MCP Layer', feature: 'mcp', href: '/dashboard/connect#mcp-title' },
  { id: 'drafts', title: 'AI Drafts', description: 'Review, edit and approve AI-assisted replies.', group: 'Create', glyph: 'draft', area: 'Workflow Automation', product: 'drafts', feature: 'drafts' },
  { id: 'knowledge', title: 'Knowledge & Integrations', description: 'Give your AI approved company context.', group: 'Create', glyph: 'book', area: 'Knowledge & Integrations', product: 'knowledge', note: 'Connecting document sources such as SharePoint or Google Drive is not available yet.', feature: 'knowledge' },
  { id: 'media', title: 'Media Studio', description: 'Manage media jobs and their results.', group: 'Create', glyph: 'film', area: 'Video Generation', product: 'media', feature: 'media' },
  { id: 'workspace', title: 'Chat', description: 'Private AI chat with your apps and knowledge.', group: 'Create', glyph: 'chat', area: 'Core Workspace', product: 'workspace', feature: 'chat' },
  { id: 'research', title: 'Research & Search', description: 'Source-based research and document analysis.', group: 'Create', glyph: 'book', area: 'Research & Search' },
  { id: 'agents', title: 'Custom AI Agents', description: 'Reusable assistants with knowledge and tools.', group: 'Create', glyph: 'spark', area: 'Custom AI Agents', feature: 'agents' },
  { id: 'calendar', title: 'Calendar & Booking', description: 'Bring scheduling closer to your team.', group: 'Operate', glyph: 'calendar', area: 'Workflow Automation', product: 'calendar' },
  { id: 'catalog', title: 'Catalog', description: 'Your products and services, organized.', group: 'Operate', glyph: 'book', area: 'CRM Hub' },
  { id: 'analytics', title: 'Usage & Costs', description: 'Understand your organization’s AI activity.', group: 'Operate', glyph: 'chart', area: 'Administration & Governance', product: 'analytics', feature: 'analytics' },
  { id: 'workflows', title: 'Workflow Automation', description: 'Multi-step processes and human approvals.', group: 'Operate', glyph: 'draft', area: 'Workflow Automation', note: 'For now, AI Drafts covers reviewing and approving replies.', feature: 'agents' },
  { id: 'developer', title: 'Developer Platform', description: 'APIs for agents, knowledge and integrations.', group: 'Operate', glyph: 'spark', area: 'Developer Platform' },
  { id: 'governance', title: 'Administration & Governance', description: 'Permissions, policies and oversight.', group: 'Operate', glyph: 'book', area: 'Administration & Governance', note: 'Permissions already apply to every organization. Members and invitations are in Settings.' },
  { id: 'privacy', title: 'Privacy & Deployment', description: 'Secure adoption and deployment choices.', group: 'Operate', glyph: 'book', area: 'Privacy & Deployment', note: 'Choosing where TuGPT is hosted is not available in the Dashboard yet.' },
];
const EN = createTranslator('en');
/** Group heading and subline in the reader's language; `name` stays the stable id. */
export const groupText = (g: Group, t: Translator = EN) => ({ title: t(`cap.group.${g}`), sub: t(`cap.group.${g}.sub`) });

/** Cards in the reader's language (the English constants above are the fallback), so search matches what is shown. */
export function capabilityViews(products: readonly ProductView[], t: Translator = EN) {
  return CAPABILITIES.map(c => ({
    ...c,
    title: t.maybe(`cap.${c.id}.title`, c.title),
    description: t.maybe(`cap.${c.id}.desc`, c.description),
    note: c.note ? t.maybe(`cap.${c.id}.note`, c.note) : undefined,
    productView: products.find(p => p.id === c.product) ?? null,
  }));
}
