import type { MessageKey } from '@/i18n/types';
import { WORKSPACE_AGENTS, WORKSPACE_APPROVALS, WORKSPACE_HOME, WORKSPACE_IMAGES, WORKSPACE_LIBRARY } from './routes';

/** The Workspace areas that work today. Each links to a real page backed by a real API. */
export type WorkspaceIcon = 'chat' | 'agents' | 'library' | 'images' | 'approvals';
export interface WorkspaceSection {
  readonly key: WorkspaceIcon;
  readonly href: string;
  readonly labelKey: MessageKey;
}

export const WORKSPACE_SECTIONS: readonly WorkspaceSection[] = [
  { key: 'chat', href: WORKSPACE_HOME, labelKey: 'workspace.chat' },
  { key: 'agents', href: WORKSPACE_AGENTS, labelKey: 'workspace.area.agents' },
  { key: 'library', href: WORKSPACE_LIBRARY, labelKey: 'workspace.area.library' },
  { key: 'images', href: WORKSPACE_IMAGES, labelKey: 'workspace.area.images' },
];

/**
 * Approvals: shown only once the approvals API has answered on this server (the frame probes it),
 * so nobody is sent to a page that cannot load.
 */
export const WORKSPACE_APPROVALS_SECTION: WorkspaceSection = { key: 'approvals', href: WORKSPACE_APPROVALS, labelKey: 'workspace.area.approvals' };

/**
 * Workspace areas that are agreed but not built yet. They are listed so people can see where the
 * Workspace is going, and every one is marked as not available: nothing here links to a
 * placeholder page. An area whose feature already works elsewhere links there and says so.
 */
export interface UpcomingArea {
  readonly key: string;
  readonly labelKey: MessageKey;
  /** The working feature in the Dashboard, until it moves into the Workspace. */
  readonly dashboardHref?: string;
}

export const WORKSPACE_UPCOMING: readonly UpcomingArea[] = [
  { key: 'projects', labelKey: 'workspace.area.projects' },
  { key: 'workflows', labelKey: 'workspace.area.workflows' },
  { key: 'tasks', labelKey: 'workspace.area.tasks' },
  { key: 'meetings', labelKey: 'workspace.area.meetings' },
  { key: 'plugins', labelKey: 'workspace.area.plugins' },
];
