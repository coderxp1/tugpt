/**
 * Workspace URLs. Pure helpers shared by the frame, the chat view, the pages and tests,
 * so "which chat does this address mean" has one answer.
 */
export const WORKSPACE_HOME = '/workspace';
export const WORKSPACE_AGENTS = '/workspace/agents';
export const WORKSPACE_LIBRARY = '/workspace/library';
export const WORKSPACE_IMAGES = '/workspace/images';
export const WORKSPACE_APPROVALS = '/workspace/approvals';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thread ids are database UUIDs. Anything else in the address is not a chat. */
export function isThreadId(value: string): boolean {
  return UUID.test(value);
}

export function threadHref(id: string): string {
  return `${WORKSPACE_HOME}/c/${encodeURIComponent(id)}`;
}

/** The chat a Workspace address points at, or null for a new chat or any other page. */
export function threadIdFromPath(pathname: string | null | undefined): string | null {
  const match = /^\/workspace\/c\/([^/?#]+)\/?$/.exec(pathname ?? '');
  return match && isThreadId(match[1]) ? match[1].toLowerCase() : null;
}

/** True on the Workspace chat surface: a new chat or an open one. */
export function isChatPath(pathname: string | null | undefined): boolean {
  return pathname === WORKSPACE_HOME || pathname === `${WORKSPACE_HOME}/` || threadIdFromPath(pathname) !== null;
}

/** True when `pathname` is the Workspace section at `href` (or a page inside it). */
export function isSectionPath(pathname: string | null | undefined, href: string): boolean {
  if (href === WORKSPACE_HOME) return isChatPath(pathname);
  const p = (pathname ?? '').replace(/\/+$/, '');
  return p === href || p.startsWith(`${href}/`);
}

/** A new chat that opens with a starter prompt from the Library. Only the key travels in the URL. */
export function starterHref(key: string): string {
  return `${WORKSPACE_HOME}?prompt=${encodeURIComponent(key)}`;
}
