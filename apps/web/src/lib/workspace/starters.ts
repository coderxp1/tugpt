import type { MessageKey } from '@/i18n/types';

/**
 * Starter prompts shipped with the product (not organization data). Shown on a new chat and in the
 * Library. Only the key travels in a URL (/workspace?prompt=<key>); the text comes from the
 * dictionary, so nothing a link carries is ever put into the message box verbatim.
 */
export interface Starter { readonly key: string; readonly titleKey: MessageKey; readonly promptKey: MessageKey; readonly icon: 'write' | 'summarize' | 'plan' | 'translate' | 'analyze' | 'email' }

export const STARTERS: readonly Starter[] = [
  { key: 'email', titleKey: 'workspace.starter.email.title', promptKey: 'workspace.starter.email.prompt', icon: 'email' },
  { key: 'summarize', titleKey: 'workspace.starter.summarize.title', promptKey: 'workspace.starter.summarize.prompt', icon: 'summarize' },
  { key: 'plan', titleKey: 'workspace.starter.plan.title', promptKey: 'workspace.starter.plan.prompt', icon: 'plan' },
  { key: 'translate', titleKey: 'workspace.starter.translate.title', promptKey: 'workspace.starter.translate.prompt', icon: 'translate' },
  { key: 'analyze', titleKey: 'workspace.starter.analyze.title', promptKey: 'workspace.starter.analyze.prompt', icon: 'analyze' },
  { key: 'write', titleKey: 'workspace.starter.write.title', promptKey: 'workspace.starter.write.prompt', icon: 'write' },
];

export function findStarter(key: string | null | undefined): Starter | null {
  return STARTERS.find((s) => s.key === key) ?? null;
}
