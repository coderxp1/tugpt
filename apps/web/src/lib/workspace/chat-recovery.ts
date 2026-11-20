/** Tab-local recovery survives reload without leaving prompt text in persistent localStorage. */
export interface ChatRecovery { threadId: string; original: string; partial: string; userMessageId?: string }
const key = (scope: string, thread: string) => `tugpt:chat-recovery:v1:${encodeURIComponent(scope)}:${encodeURIComponent(thread)}`;
export function saveChatRecovery(scope: string | undefined, record: ChatRecovery): boolean {
  if (!scope) return true; // Non-session consumers; authenticated Workspace always supplies scope.
  try { sessionStorage.setItem(key(scope, record.threadId), JSON.stringify({ ...record, partial: record.partial.slice(0, 65536) })); return true; } catch { return false; }
}
export function loadChatRecovery(scope: string | undefined, threadId: string): ChatRecovery | null {
  if (!scope) return null;
  try {
    const raw = sessionStorage.getItem(key(scope, threadId)); if (!raw) return null;
    const r = JSON.parse(raw) as ChatRecovery;
    if (r.threadId !== threadId || typeof r.original !== 'string' || typeof r.partial !== 'string' || r.original.length > 100000 || r.partial.length > 65536 || (r.userMessageId !== undefined && typeof r.userMessageId !== 'string')) return { threadId, original: '', partial: '' };
    return r;
  } catch { return { threadId, original: '', partial: '' }; }
}
export function clearChatRecovery(scope: string | undefined, threadId: string): boolean {
  if (!scope) return true;
  try { sessionStorage.removeItem(key(scope, threadId)); return true; } catch { return false; }
}
/** Do not mistake unrelated, older, pending or failed answers for this request settling. */
export function hasRecoveredAnswer(record: ChatRecovery, messages: readonly { id: string; role: string; content: string; status: string }[]): boolean {
  if (!record.userMessageId) return false;
  const i = messages.findIndex(m => m.id === record.userMessageId && m.role === 'user' && m.content === record.original);
  if (i < 0) return false;
  for (const m of messages.slice(i + 1)) {
    if (m.role === 'user') return false;
    if (m.role === 'assistant') return m.status === 'complete';
  }
  return false;
}
