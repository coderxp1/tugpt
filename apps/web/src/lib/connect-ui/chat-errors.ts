/**
 * Human wording for every way an integration can fail in chat. Codes come
 * from @tugpt/connect-runtime (ToolErrorCode) and the messages route's 409s.
 * `connect: true` means the fix is on the Connect page, so the UI links there.
 */
export interface ChatProblem { readonly text: string; readonly connect: boolean }

const TOOL: Record<string, ChatProblem> = {
  NOT_GRANTED: { text: 'You do not have access to this connection. Ask an admin to share it with you.', connect: false },
  POLICY_DISABLED: { text: 'Your organization has turned this app off.', connect: false },
  SCOPE_MISSING: { text: 'The connection is missing a permission this needs. Reconnect the account.', connect: true },
  APPROVAL_REQUIRED: { text: 'Waiting for approval from an owner or admin. Nothing was changed yet; see the approval card below.', connect: false },
  PROVIDER_MISMATCH: { text: 'The attached connection belongs to a different provider.', connect: true },
  CONNECTION_NOT_FOUND: { text: 'The connection no longer exists. Connect the account again.', connect: true },
  CONNECTION_NOT_ACTIVE: { text: 'The connection is not active. Connect the account again.', connect: true },
  REAUTHORIZATION_REQUIRED: { text: 'The provider asked to sign in again. Reconnect the account.', connect: true },
  PROVIDER_UNAVAILABLE: { text: 'The app could not be reached right now. Nothing was changed; try again later.', connect: false },
  TOOL_ERROR: { text: 'The app received the request but reported a problem with it. Check the details and try again.', connect: false },
  UNKNOWN_TOOL: { text: 'This app is not available in chat yet.', connect: false },
  AUDIT_UNAVAILABLE: { text: 'The call could not be recorded in the audit log, so it was not run.', connect: false },
  INVALID_ARGUMENTS: { text: 'The model asked for this in a form the app does not accept. Nothing was changed; try rephrasing.', connect: false },
  OUTPUT_TOO_LARGE: { text: 'The app returned more data than chat can use at once. Try a narrower question.', connect: false },
  CALL_BUDGET_EXCEEDED: { text: 'This message used the most app calls allowed for one answer. Ask again for the rest.', connect: false },
  INTERNAL: { text: 'Something went wrong on our side. Nothing was changed.', connect: false },
};

export function toolProblem(code: string | undefined): ChatProblem {
  return (code && TOOL[code]) || { text: 'The app could not complete this step.', connect: false };
}

const REQUEST: Record<string, ChatProblem> = {
  'An attached integration is not connected': { text: 'One of the attached apps is not connected. Connect it, or remove it from the message.', connect: true },
  'This model cannot use integrations': { text: 'The selected model has not passed tool-calling verification, so it cannot use apps. Remove the app or pick another model.', connect: false },
  'This integration is not available in chat yet': { text: 'One of the attached apps is not available in chat yet. Remove it to send the message.', connect: false },
  'Unknown model': { text: 'This model is no longer available. Pick another one.', connect: false },
  'Two attached integrations offer the same tool. Attach one of them per message': { text: 'Two of the attached apps offer a tool with the same name. Keep one and send the other question separately.', connect: false },
  'Attach one calendar per message': { text: 'Google and Outlook calendars cannot be attached to the same message yet. Keep one and send the other question separately.', connect: false },
};

/** Maps a server `error` string (or nothing) to what the person should read. */
export function requestProblem(serverError: string | undefined): ChatProblem {
  return (serverError && REQUEST[serverError]) || { text: serverError || 'The message could not be sent.', connect: false };
}

export interface PickerCapability { state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available'; toolAvailable?: boolean; unavailableReason?: string }

/** Why a customer MCP tool is off in chat (codes from lib/chat/mcp.ts mcpUnavailableReason). */
const MCP_UNAVAILABLE: Record<string, string> = {
  MCP_FEATURE_OFF: 'Custom tools are switched off',
  MCP_CHAT_EXECUTION_OFF: 'Not available in chat yet: running custom tools from chat is switched off',
  MCP_EGRESS_NOT_CONFIGURED: 'Not available in chat yet: no secure network proxy is set up',
  MCP_AUDIT_UNAVAILABLE: 'Not available in chat yet: calls cannot be recorded',
  MCP_NOT_RUNNABLE: 'Not available in chat: needs review in Connect',
};

/** null = selectable; otherwise the reason shown next to the app. */
export function pickerBlock(c: PickerCapability, modelCanUseTools: boolean): string | null {
  if (c.state === 'disabled_by_policy') return 'Turned off by your organization';
  if (c.state === 'not_available') return 'Not available yet';
  if (c.toolAvailable === false) return (c.unavailableReason && MCP_UNAVAILABLE[c.unavailableReason]) || 'Not available in chat yet';
  if (c.state === 'requires_connection') return 'Connect first';
  if (!modelCanUseTools) return 'This model can\u2019t use apps yet';
  return null;
}

const TURN: Record<string, string> = {
  MODEL_UNAVAILABLE: 'The model is not reachable right now. Try again in a moment.',
  MODEL_BAD_RESPONSE: 'The model sent an answer TuGPT could not read. Try again.',
  TURN_FAILED: 'The answer could not be completed.',
  STORE_UNAVAILABLE: 'The answer could not be saved. Reload to see what was kept.',
  INTERRUPTED: 'The answer was cut off before it finished. Reload to see what was saved, then try again.',
};

/** Wording for a failed turn: an `error` stream event code, or INTERRUPTED when the stream ended without done/error. */
export function turnProblem(code: string | undefined): string {
  return (code && TURN[code]) || TURN.TURN_FAILED;
}

/** Label for a live tool step, naming the account it uses (provider comes from the server, not the model). */
export function toolLabel(tool: string, provider?: string | null): string {
  const base = tool === 'calendar_find_availability' ? 'Checking calendar availability' : `Using ${tool}`;
  return provider ? `${base} in ${provider}` : base;
}
