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
  APPROVAL_REQUIRED: { text: 'This action needs your approval, which chat cannot ask for yet. Nothing was changed.', connect: false },
  PROVIDER_MISMATCH: { text: 'The attached connection belongs to a different provider.', connect: true },
  CONNECTION_NOT_FOUND: { text: 'The connection no longer exists. Connect the account again.', connect: true },
  CONNECTION_NOT_ACTIVE: { text: 'The connection is not active. Connect the account again.', connect: true },
  REAUTHORIZATION_REQUIRED: { text: 'The provider asked to sign in again. Reconnect the account.', connect: true },
  PROVIDER_UNAVAILABLE: { text: 'The app could not be reached right now. Nothing was changed; try again later.', connect: false },
  UNKNOWN_TOOL: { text: 'This app is not available in chat yet.', connect: false },
  AUDIT_UNAVAILABLE: { text: 'The call could not be recorded in the audit log, so it was not run.', connect: false },
};

export function toolProblem(code: string | undefined): ChatProblem {
  return (code && TOOL[code]) || { text: 'The app could not complete this step.', connect: false };
}

const REQUEST: Record<string, ChatProblem> = {
  'An attached integration is not connected': { text: 'One of the attached apps is not connected. Connect it, or remove it from the message.', connect: true },
  'This model cannot use integrations': { text: 'The selected model has not passed tool-calling verification, so it cannot use apps. Remove the app or pick another model.', connect: false },
  'This integration is not available in chat yet': { text: 'One of the attached apps is not available in chat yet. Remove it to send the message.', connect: false },
  'Unknown model': { text: 'This model is no longer available. Pick another one.', connect: false },
};

/** Maps a server `error` string (or nothing) to what the person should read. */
export function requestProblem(serverError: string | undefined): ChatProblem {
  return (serverError && REQUEST[serverError]) || { text: serverError || 'The message could not be sent.', connect: false };
}

export interface PickerCapability { state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available'; toolAvailable?: boolean }

/** null = selectable; otherwise the reason shown next to the app. */
export function pickerBlock(c: PickerCapability, modelCanUseTools: boolean): string | null {
  if (c.state === 'disabled_by_policy') return 'Turned off by your organization';
  if (c.state === 'not_available') return 'Not available yet';
  if (c.toolAvailable === false) return 'Not available in chat yet';
  if (c.state === 'requires_connection') return 'Connect first';
  if (!modelCanUseTools) return 'This model can\u2019t use apps yet';
  return null;
}
