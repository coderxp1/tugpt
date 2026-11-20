import { workspaceAgentsEnabled } from './agent-release-gate';

/** C-1 response item: GET /api/v1/agents. Kept here so UI and contract cannot drift. */
export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who can use it: only the creator, a group, or the whole organization. */
  readonly visibility: 'private' | 'group' | 'organization';
  /** Model key from the chat model catalogue; null = person's choice. */
  readonly modelKey: string | null;
  readonly knowledgeSources: number;
  readonly capabilities: readonly string[];
  readonly starters: readonly string[];
  readonly builtIn: boolean;
  readonly updatedAt: string | null;
}

export const BUILT_IN_AGENT_ID = 'tugpt-assistant';

export const BUILT_IN_AGENT: AgentSummary = {
  id: BUILT_IN_AGENT_ID,
  name: 'TuGPT Assistant',
  description: 'The general assistant for your organization. Uses the model you pick and the apps you attach with @.',
  visibility: 'organization',
  modelKey: null,
  knowledgeSources: 0,
  capabilities: ['chat', 'apps'],
  starters: [],
  builtIn: true,
  updatedAt: null,
};

/** Default off. Explicit staging build opt-in; never an authorization boundary. */
export const agentsApiAvailable = workspaceAgentsEnabled(
  process.env.NEXT_PUBLIC_TUGPT_DEPLOYMENT_TIER,
  process.env.NEXT_PUBLIC_TUGPT_WORKSPACE_AGENTS,
);

export interface AgentCatalogue { readonly agents: readonly AgentSummary[]; readonly customAgentsAvailable: boolean }

export function agentCatalogue(): AgentCatalogue {
  return { agents: [BUILT_IN_AGENT], customAgentsAvailable: agentsApiAvailable };
}
