/**
 * Customer-facing text for invitation API errors.
 * The invitation RPC codes (P3D01–P3D10) are mapped server-side to stable codes with sentences
 * written for end users (lib/draft-api/error-mapper.ts); those are shown verbatim. Everything
 * else falls back to status-based text so raw server details never reach the screen.
 */
export const FRIENDLY_INVITATION_CODES = new Set([
  'INVITATION_NOT_FOUND', 'INVITATION_ALREADY_PENDING', 'INVITATION_NOT_PENDING', 'INVITATION_EXPIRED',
  'INVITATION_WRONG_ACCOUNT', 'ALREADY_A_MEMBER', 'ROLE_ABOVE_YOUR_OWN', 'INVALID_EMAIL', 'VERIFIED_EMAIL_REQUIRED',
]);
export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export type InvitationError = { status: number; code: string | null; message: string };

export async function readInvitationError(res: Response): Promise<InvitationError> {
  let code: string | null = null;
  let serverMessage: string | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') serverMessage = body.error.message;
  } catch { /* non-JSON body */ }
  return { status: res.status, code, message: invitationErrorText(res.status, code, serverMessage) };
}

export function invitationErrorText(status: number, code: string | null, serverMessage: string | null): string {
  if (code && FRIENDLY_INVITATION_CODES.has(code) && serverMessage) return serverMessage;
  if (status === 401) return 'Your session has ended. Sign in again to continue.';
  if (status === 403) return 'Only owners and administrators can manage invitations.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 400 && serverMessage) return serverMessage;
  return GENERIC_ERROR;
}
