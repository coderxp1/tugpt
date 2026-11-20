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
import { createTranslator } from '@/i18n';
import type { Translator } from '@/i18n/types';

const EN = createTranslator('en');
export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export type InvitationError = { status: number; code: string | null; message: string };

export async function readInvitationError(res: Response, t: Translator = EN): Promise<InvitationError> {
  let code: string | null = null;
  let serverMessage: string | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') serverMessage = body.error.message;
  } catch { /* non-JSON body */ }
  return { status: res.status, code, message: invitationErrorText(res.status, code, serverMessage, t) };
}

export function invitationErrorText(status: number, code: string | null, serverMessage: string | null, t: Translator = EN): string {
  // Known codes have a sentence in both dictionaries; the server's English sentence is the fallback.
  if (code && FRIENDLY_INVITATION_CODES.has(code) && serverMessage) return t.maybe(`errors.${code}`, serverMessage);
  if (status === 401) return t('team.err.401');
  if (status === 403) return t('team.err.403');
  if (status === 429) return t('team.err.429');
  // 400 without a known code: the server's text is English and may be technical; say what to check instead.
  if (status === 400 && serverMessage) return t.locale === 'en' ? serverMessage : t('team.err.badRequest');
  return t('team.err.generic');
}
