/**
 * Custom agents: the typed client for contract C-1 (docs/workspace/api-contracts.md).
 *
 * The builder uses the C-1 field names (starters and inline collectionIds). Its UI
 * write gate remains disabled until the real API and execution flow are verified.
 * JSON errors are `{ error: CODE }`; same-origin cookies and `x-tugpt-csrf: 1`
 * protect mutations. Never serialize response-only fields back to the server.
 */
import type { WorkspaceResult } from '@/lib/workspace-data/contracts';

export type AgentVisibility = 'private' | 'organization';

/** C-1 resource. */
export interface CustomAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** System instructions. Server limit 8,000 characters. */
  readonly instructions: string;
  /** Chat model key from the catalogue; null = the person's choice in the composer. */
  readonly modelKey: string | null;
  /** Up to four conversation starters, each at most 200 characters. */
  readonly starters: readonly string[];
  /** Library collections searched for answers (Agent 4's Library API). */
  readonly collectionIds: readonly string[];
  readonly visibility: AgentVisibility;
  readonly ownedByMe: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentInput = Pick<CustomAgent, 'name' | 'description' | 'instructions' | 'modelKey' | 'starters' | 'collectionIds' | 'visibility'>;

export const AGENT_LIMITS = { name: 80, description: 280, instructions: 8000, starters: 4, starter: 200, collections: 10 } as const;

const INPUT_FIELDS = ['name', 'description', 'instructions', 'modelKey', 'starters', 'collectionIds', 'visibility'] as const;

/** Whitelist at the transport boundary too; TypeScript does not strip runtime properties. */
function agentPatch(input: Partial<AgentInput>): Partial<AgentInput> {
  return Object.fromEntries(INPUT_FIELDS
    .filter((key) => Object.hasOwn(input, key) && input[key] !== undefined)
    .map((key) => [key, input[key]])) as Partial<AgentInput>;
}

export const AGENTS_API = {
  agents: '/api/v1/agents',
  agent: (id: string) => `/api/v1/agents/${encodeURIComponent(id)}`,
} as const;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createAgentsClient(fetchFn: FetchFn = (i, init) => fetch(i, init)) {
  async function call<T>(method: string, url: string, body?: unknown): Promise<WorkspaceResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['x-tugpt-csrf'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try { res = await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); } catch { return { ok: false, status: 0, error: 'NETWORK_ERROR' }; }
    let json: unknown = null;
    try { json = res.status === 204 ? null : await res.json(); } catch { if (res.ok) return { ok: false, status: res.status, error: 'UNEXPECTED_RESPONSE' }; }
    if (!res.ok) {
      const code = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : 'UNEXPECTED_RESPONSE';
      return { ok: false, status: res.status, error: code as 'UNEXPECTED_RESPONSE' };
    }
    return { ok: true, value: json as T };
  }
  return {
    listAgents: () => call<{ agents: readonly CustomAgent[] }>('GET', AGENTS_API.agents),
    createAgent: (input: AgentInput) => call<{ agent: CustomAgent }>('POST', AGENTS_API.agents, cleanAgent(input)),
    updateAgent: (id: string, patch: Partial<AgentInput>) => call<{ agent: CustomAgent }>('PATCH', AGENTS_API.agent(id), agentPatch(patch)),
    deleteAgent: (id: string) => call<{ deleted: true }>('DELETE', AGENTS_API.agent(id)),
  };
}
export type AgentsClient = ReturnType<typeof createAgentsClient>;

let client: AgentsClient | null = null;
export function agentsApi(): AgentsClient { client ??= createAgentsClient(); return client; }
export function setAgentsApi(next: AgentsClient | null): void { client = next; }

/** Client-side checks mirroring C-1 (the server validates again). Returns the first problem, or null. */
export function validateAgent(input: AgentInput): 'name' | 'instructions' | 'starters' | null {
  if (!input.name.trim() || input.name.length > AGENT_LIMITS.name) return 'name';
  if (!input.instructions.trim() || input.instructions.length > AGENT_LIMITS.instructions) return 'instructions';
  if (input.starters.length > AGENT_LIMITS.starters || input.starters.some((x) => x.length > AGENT_LIMITS.starter)) return 'starters';
  return null;
}

/** Trims and drops empty starters; what is actually sent. */
export function cleanAgent(input: AgentInput): AgentInput {
  return {
    name: input.name.trim(),
    description: input.description?.trim() ? input.description.trim() : null,
    instructions: input.instructions.trim(),
    modelKey: input.modelKey,
    visibility: input.visibility,
    starters: input.starters.map((x) => x.trim()).filter(Boolean).slice(0, AGENT_LIMITS.starters),
    collectionIds: [...new Set(input.collectionIds)].slice(0, AGENT_LIMITS.collections),
  };
}
