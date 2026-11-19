/** Runtime-checked stream metadata. No URLs or HTML supplied by events are rendered. */
import type { Citation as AgentCitation } from '@/lib/workspace-data/contracts';
export type { Citation as AgentCitation } from '@/lib/workspace-data/contracts';
export function parseAgentIdentity(value: unknown): { id: string; name: string; version: number } | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  return typeof a.id === 'string' && typeof a.name === 'string' && typeof a.version === 'number' && Number.isInteger(a.version) && a.version > 0
    ? { id: a.id, name: a.name, version: a.version } : null;
}
export function parseAgentCitations(value: unknown): AgentCitation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is AgentCitation => c !== null && typeof c === 'object'
    && Number.isInteger(c.n) && c.n > 0 && Number.isInteger(c.ordinal) && c.ordinal >= 0
    && ['documentId', 'collectionId', 'fileId', 'title', 'snippet'].every((k) => typeof c[k] === 'string'));
}
