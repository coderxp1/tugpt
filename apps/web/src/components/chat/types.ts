import type { PendingApproval } from '@/lib/chat/approval';

export interface PublicModel { key: string; label: string; description: string; private: boolean; toolCalling: boolean }
/** `folderId` is only known when the Workspace conversations API is available (null = not in a folder). */
export interface Thread { id: string; title: string; modelKey: string; updatedAt: string; folderId?: string | null }
export interface Message {
  id: string; role: 'user' | 'assistant' | 'tool'; content: string; status: 'complete' | 'error' | 'stopped';
  mentions: { capability: string; provider: string }[]; capabilityKey: string | null;
}
export type Live = { text: string; tools: { tool: string; provider?: string | null; ok?: boolean; code?: string }[] } | null;
export interface ApprovalItem { approval: PendingApproval; afterId: string | null }
export type RunResult = { ok: boolean; code?: string; message?: string };
