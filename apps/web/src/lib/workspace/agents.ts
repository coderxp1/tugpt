/**
 * Agents in the Workspace: a typed adapter, so the UI is built against the contract and not against
 * an endpoint that does not exist yet.
 *
 * Today there is exactly one agent, and it is real: the TuGPT Assistant is the Workspace chat itself
 * (system prompt and tools are set by the chat backend). Custom agents need the Agents API
 * (docs/workspace/api-contracts.md, C-1). Until it ships, `agentsApiAvailable` is false and
 * the UI says so; it never lists agents that cannot be used.
 */

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

/** Flip only when GET /api/v1/agents exists and is covered by tests (C-1). */
export const agentsApiAvailable = false;

export interface AgentCatalogue { readonly agents: readonly AgentSummary[]; readonly customAgentsAvailable: boolean }

export function agentCatalogue(): AgentCatalogue {
  return { agents: [BUILT_IN_AGENT], customAgentsAvailable: agentsApiAvailable };
}
