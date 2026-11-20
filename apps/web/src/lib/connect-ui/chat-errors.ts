/**
 * Human wording for every way an integration can fail in chat. Codes come
 * from @tugpt/connect-runtime (ToolErrorCode) and the messages route's 409s.
 * `connect: true` means the fix is on the Connect page, so the UI links there.
 * Every function takes the reader's translator; the default is English.
 */
import { createTranslator } from '@/i18n';
import type { MessageKey, Translator } from '@/i18n/types';

const EN = createTranslator('en');

export interface ChatProblem { readonly text: string; readonly connect: boolean }

/** Tool error codes the dictionary knows, and whether the fix lives in Connect. */
const TOOL_CONNECT: Record<string, boolean> = {
  NOT_GRANTED: false, POLICY_DISABLED: false, SCOPE_MISSING: true, APPROVAL_REQUIRED: false,
  PROVIDER_MISMATCH: true, CONNECTION_NOT_FOUND: true, CONNECTION_NOT_ACTIVE: true, REAUTHORIZATION_REQUIRED: true,
  PROVIDER_UNAVAILABLE: false, UNKNOWN_TOOL: false, AUDIT_UNAVAILABLE: false, INVALID_ARGUMENTS: false,
  TOOL_ERROR: false, OUTPUT_TOO_LARGE: false, CALL_BUDGET_EXCEEDED: false, INTERNAL: false,
};

export function toolProblem(code: string | undefined, t: Translator = EN): ChatProblem {
  if (code && code in TOOL_CONNECT) return { text: t(`chat.tool.${code}` as MessageKey), connect: TOOL_CONNECT[code] };
  return { text: t('chat.tool.default'), connect: false };
}

/** The messages route answers with English sentences; each known one maps to a key. */
const REQUEST: Record<string, { key: MessageKey; connect: boolean }> = {
  'An attached integration is not connected': { key: 'chat.req.notConnected', connect: true },
  'This model cannot use integrations': { key: 'chat.req.cannotUseTools', connect: false },
  'This integration is not available in chat yet': { key: 'chat.req.notInChat', connect: false },
  'Unknown model': { key: 'chat.req.unknownModel', connect: false },
  'Two attached integrations offer the same tool. Attach one of them per message': { key: 'chat.req.duplicateTool', connect: false },
  'Attach one calendar per message': { key: 'chat.req.oneCalendar', connect: false },
};

/** Maps a server `error` string (or nothing) to what the person should read. Unknown text maps to a generic message. */
export function requestProblem(serverError: string | undefined, t: Translator = EN): ChatProblem {
  const known = serverError ? REQUEST[serverError] : undefined;
  if (known) return { text: t(known.key), connect: known.connect };
  // RC4 integration: unknown server text is not shown to customers (could carry internal detail); generic message instead.
  return { text: t('chat.req.default'), connect: false };
}

export interface PickerCapability { state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available'; toolAvailable?: boolean; unavailableReason?: string }

/** Why a customer MCP tool is off in chat (codes from lib/chat/mcp.ts mcpUnavailableReason). */
const MCP_UNAVAILABLE = new Set(['MCP_FEATURE_OFF', 'MCP_CHAT_EXECUTION_OFF', 'MCP_EGRESS_NOT_CONFIGURED', 'MCP_AUDIT_UNAVAILABLE', 'MCP_NOT_RUNNABLE']);

/** null = selectable; otherwise the reason shown next to the app. */
export function pickerBlock(c: PickerCapability, modelCanUseTools: boolean, t: Translator = EN): string | null {
  if (c.state === 'disabled_by_policy') return t('chat.block.policy');
  if (c.state === 'not_available') return t('chat.block.notAvailable');
  if (c.toolAvailable === false) return c.unavailableReason && MCP_UNAVAILABLE.has(c.unavailableReason) ? t(`chat.mcp.${c.unavailableReason}` as MessageKey) : t('chat.block.notInChat');
  if (c.state === 'requires_connection') return t('chat.block.connectFirst');
  if (!modelCanUseTools) return t('chat.block.modelNoTools');
  return null;
}

const TURN = new Set(['MODEL_UNAVAILABLE', 'MODEL_BAD_RESPONSE', 'TURN_FAILED', 'STORE_UNAVAILABLE', 'INTERRUPTED']);

/** Wording for a failed turn: an `error` stream event code, or INTERRUPTED when the stream ended without done/error. */
export function turnProblem(code: string | undefined, t: Translator = EN): string {
  return t(`chat.turn.${code && TURN.has(code) ? code : 'TURN_FAILED'}` as MessageKey);
}

/** Label for a live tool step, naming the account it uses (provider comes from the server, not the model). */
export function toolLabel(tool: string, provider?: string | null, t: Translator = EN): string {
  const base = tool === 'calendar_find_availability' ? t('chat.label.calendar') : t('chat.label.using', { tool });
  return provider ? t('chat.label.in', { base, provider }) : base;
}

/**
 * A stored tool message is written by the server as "<Provider> responded" or
 * "<Provider> failed: <CODE>" (messages and approved-call routes). The raw tool
 * output is not stored, so this is all a reloaded chat can know about the call.
 */
export interface StoredToolResult { readonly provider: string | null; readonly ok: boolean; readonly code: string | null }
export function parseStoredToolResult(content: string, status: 'complete' | 'error' | 'stopped'): StoredToolResult {
  const failed = /^(.+?) failed: ([A-Z0-9_]+)$/.exec(content);
  if (failed) return { provider: failed[1] === 'Integration' ? null : failed[1], ok: false, code: failed[2] };
  const ok = /^(.+?) responded$/.exec(content);
  if (ok) return { provider: ok[1] === 'Integration' ? null : ok[1], ok: status !== 'error', code: null };
  return { provider: null, ok: status === 'complete', code: null };
}
