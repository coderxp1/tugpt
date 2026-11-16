/**
 * Server half of chat approvals: the argument hash and the event payload.
 *
 * The hash must equal the one ConnectToolRuntime computes before it claims an
 * approval (packages/connect-runtime/src/runtime.ts): sha256 over the
 * canonical JSON of the raw call arguments (keys sorted, no whitespace).
 * approval.test.ts asserts equality against the runtime's own audit event.
 */
import { createHash } from 'node:crypto';
import type { PendingApproval } from './approval';

export function canonicalArgumentsJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalArgumentsJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalArgumentsJson(o[k])}`).join(',')}}`;
}

export function argumentsSha256(args: unknown): string {
  return createHash('sha256').update(canonicalArgumentsJson(args)).digest('hex');
}

/** Approval details for one MCP call; built only from server-side rows (never from the model). */
export type ApprovalTarget = Omit<PendingApproval, 'callId' | 'threadId' | 'arguments' | 'argumentsSha256'>;

export function pendingApproval(target: ApprovalTarget, input: { callId: string; threadId: string; arguments: Readonly<Record<string, unknown>> }): PendingApproval {
  return { ...target, callId: input.callId, threadId: input.threadId, arguments: input.arguments, argumentsSha256: argumentsSha256(input.arguments) };
}

/** Upper bound for arguments sent back to the run route. */
export const MAX_ARGUMENT_BYTES = 16 * 1024;
