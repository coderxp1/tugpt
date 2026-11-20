/**
 * Chat persistence through the caller's own RLS-bound client.
 *
 * What a user can read or write here is exactly what the chat policies and
 * column grants allow (20261115000001, 20261120200002/3). Two things are not
 * the user's to touch directly (Q-9c):
 * - citations are read only through chat_message_citations, which filters each
 *   entry by the reader's CURRENT document access in the database (F-2);
 * - assistant and tool messages are written only by the server, through
 *   append_chat_message_server on the sso_control client (F-3). There is still
 *   no service-role path.
 * Rows come back as `unknown` and are parsed, so a schema drift fails loudly
 * instead of rendering junk.
 */
export interface DbResult { readonly data: unknown; readonly error: { readonly message?: string; readonly code?: string } | null }
export interface DbQuery extends PromiseLike<DbResult> {
  select(columns: string): DbQuery;
  eq(column: string, value: unknown): DbQuery;
  is(column: string, value: null): DbQuery;
  in(column: string, values: readonly unknown[]): DbQuery;
  order(column: string, options: { ascending: boolean }): DbQuery;
  limit(n: number): DbQuery;
  single(): PromiseLike<DbResult>;
  maybeSingle(): PromiseLike<DbResult>;
}
export interface ChatDb {
  from(table: string): { select(columns: string): DbQuery; insert(values: object): DbQuery; update(values: object): DbQuery };
  rpc(fn: string, args: object): PromiseLike<DbResult>;
}
export function asChatDb(client: unknown): ChatDb { return client as ChatDb; }

export class ChatStoreError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'NOT_FOUND' | 'FORBIDDEN') { super(code); this.name = 'ChatStoreError'; }
}

/** agentId: the custom agent the thread was started with; null for plain chat or once that agent was deleted. */
export interface ThreadSummary { readonly id: string; readonly title: string; readonly modelKey: string; readonly updatedAt: string; readonly agentId: string | null }
/**
 * citations / knowledgeUnavailable: what an agent turn streamed with this assistant answer (20261120100010).
 * Always [] / false for user and tool messages and for plain chat.
 */
export interface StoredMessage {
  readonly id: string; readonly role: 'user' | 'assistant' | 'tool'; readonly content: string;
  readonly createdAt: string; readonly status: 'complete' | 'error' | 'stopped';
  readonly mentions: readonly Mention[]; readonly capabilityKey: string | null;
  readonly citations: readonly MessageCitation[]; readonly knowledgeUnavailable: boolean;
}
/** The streamed Citation contract (lib/workspace-data/agents.ts re-exports it as Citation). */
export interface MessageCitation {
  readonly n: number; readonly documentId: string; readonly collectionId: string; readonly fileId: string;
  readonly title: string; readonly ordinal: number; readonly snippet: string;
}
export interface Mention { readonly capability: string; readonly provider: string }
export type CapabilityState = 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available';
export interface CapabilityRow {
  readonly capabilityKey: string; readonly providerKey: string; readonly providerName: string;
  readonly description: string; readonly permissionClass: string; readonly state: CapabilityState; readonly connectionId: string | null;
}

const STATES: readonly CapabilityState[] = ['connected', 'requires_connection', 'disabled_by_policy', 'not_available'];
const str = (v: unknown): string => { if (typeof v !== 'string') throw new ChatStoreError('STORE_UNAVAILABLE'); return v; };
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));

function check(r: DbResult): unknown {
  if (r.error) throw new ChatStoreError(r.error.code === '42501' ? 'FORBIDDEN' : 'STORE_UNAVAILABLE');
  return r.data;
}

function toThread(row: unknown): ThreadSummary {
  const r = row as Record<string, unknown>;
  return { id: str(r.id), title: str(r.title), modelKey: str(r.model_key), updatedAt: str(r.updated_at), agentId: optStr(r.agent_id) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_MESSAGE_CITATIONS = 20;
export const MAX_CITATION_SNIPPET = 2000;
const isCount = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isUuidStr = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Stored citations, field by field (the database enforces the same shape); anything else is dropped. */
export function parseCitations(v: unknown): MessageCitation[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c): MessageCitation[] => {
    const o = c as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || !isCount(o.n, 1) || !isCount(o.ordinal, 0)) return [];
    if (!isUuidStr(o.documentId) || !isUuidStr(o.collectionId) || !isUuidStr(o.fileId)) return [];
    if (typeof o.title !== 'string' || typeof o.snippet !== 'string') return [];
    return [{ n: o.n, documentId: o.documentId, collectionId: o.collectionId, fileId: o.fileId, title: o.title, ordinal: o.ordinal, snippet: o.snippet }];
  }).slice(0, MAX_MESSAGE_CITATIONS);
}

/** What appendMessage stores: exactly the contract keys, bounded the way the CHECK constraint requires. */
function citationsForStorage(list: readonly MessageCitation[] | undefined): MessageCitation[] {
  return parseCitations(list ?? []).map((c) => ({ ...c, title: Array.from(c.title).slice(0, 255).join(''), snippet: Array.from(c.snippet).slice(0, MAX_CITATION_SNIPPET).join('') }))
    .filter((c) => c.title.length > 0);
}

export function parseMentions(v: unknown): Mention[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m) => {
    const o = m as Record<string, unknown>;
    return typeof o?.capability === 'string' && typeof o?.provider === 'string' ? [{ capability: o.capability, provider: o.provider }] : [];
  }).slice(0, 10);
}

function toMessage(row: unknown): StoredMessage {
  const r = row as Record<string, unknown>;
  const role = str(r.role); const status = str(r.status);
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') throw new ChatStoreError('STORE_UNAVAILABLE');
  if (status !== 'complete' && status !== 'error' && status !== 'stopped') throw new ChatStoreError('STORE_UNAVAILABLE');
  return {
    id: str(r.id), role, content: str(r.content), createdAt: str(r.created_at), status, mentions: parseMentions(r.mentions), capabilityKey: optStr(r.capability_key),
    citations: role === 'assistant' ? parseCitations(r.citations) : [], knowledgeUnavailable: role === 'assistant' && r.knowledge_unavailable === true,
  };
}

export function toCapability(row: unknown): CapabilityRow {
  const r = row as Record<string, unknown>;
  const state = str(r.state) as CapabilityState;
  if (!STATES.includes(state)) throw new ChatStoreError('STORE_UNAVAILABLE');
  return {
    capabilityKey: str(r.capability_key), providerKey: str(r.provider_key), providerName: str(r.provider_name),
    description: str(r.description), permissionClass: str(r.permission_class), state, connectionId: optStr(r.connection_id),
  };
}

const THREAD_COLS = 'id,title,model_key,updated_at,agent_id';
/** No `citations`: authenticated has no column SELECT on it (20261120200002). */
const MESSAGE_COLS = 'id,role,content,created_at,status,mentions,capability_key,knowledge_unavailable';
/** PostgREST puts in.(...) into the URL; 100 uuids stay well below proxy URL limits. */
const CITATION_CHECK_BATCH = 100;

export async function listThreads(db: ChatDb, organizationId: string, userId: string): Promise<ThreadSummary[]> {
  const data = check(await db.from('chat_threads').select(THREAD_COLS)
    .eq('organization_id', organizationId).eq('owner_user_id', userId).is('archived_at', null)
    .order('updated_at', { ascending: false }).limit(50));
  return (Array.isArray(data) ? data : []).map(toThread);
}

export async function createThread(db: ChatDb, input: { organizationId: string; userId: string; modelKey: string; title: string }): Promise<ThreadSummary> {
  const data = check(await db.from('chat_threads').insert({
    organization_id: input.organizationId, owner_user_id: input.userId, model_key: input.modelKey, title: input.title,
  }).select(THREAD_COLS).single());
  return toThread(data);
}

export async function getThread(db: ChatDb, organizationId: string, threadId: string): Promise<ThreadSummary> {
  const data = check(await db.from('chat_threads').select(THREAD_COLS).eq('id', threadId).eq('organization_id', organizationId).is('archived_at', null).maybeSingle());
  if (!data) throw new ChatStoreError('NOT_FOUND');
  return toThread(data);
}

/**
 * Messages of one thread (RLS: the thread owner only). Stored citations are a
 * snapshot, not a grant: chat_message_citations returns only the entries whose
 * document the READER can still read in the same collection and file
 * (collection made private, document removed -> left out), enforced in the
 * database. authorizeCitations re-checks the same rule under the reader's RLS
 * as a second layer. The remaining entries keep their original n, so [n]
 * markers in the answer still point at the right source.
 */
export async function listMessages(db: ChatDb, organizationId: string, threadId: string): Promise<StoredMessage[]> {
  const data = check(await db.from('chat_messages').select(MESSAGE_COLS)
    .eq('thread_id', threadId).eq('organization_id', organizationId).order('created_at', { ascending: true }).limit(400));
  const raw = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  // Only assistant messages can carry citations; the limit above (400) is the RPC's id cap.
  const cited = raw.filter((r) => r.role === 'assistant').map((r) => str(r.id));
  const citations = new Map<string, unknown>();
  if (cited.length > 0) {
    const rows = check(await db.rpc('chat_message_citations', { p_organization_id: organizationId, p_thread_id: threadId, p_message_ids: cited }));
    for (const row of Array.isArray(rows) ? rows : []) {
      const r = row as Record<string, unknown>;
      citations.set(str(r.message_id), r.citations);
    }
  }
  return authorizeCitations(db, organizationId, raw.map((r) => toMessage({ ...r, citations: citations.get(str(r.id)) ?? [] })));
}

export async function authorizeCitations(db: ChatDb, organizationId: string, messages: StoredMessage[]): Promise<StoredMessage[]> {
  const ids = [...new Set(messages.flatMap((m) => m.citations.map((c) => c.documentId)))];
  if (ids.length === 0) return messages;
  const readable = new Map<string, { collectionId: string; fileId: string }>();
  for (let i = 0; i < ids.length; i += CITATION_CHECK_BATCH) {
    const rows = check(await db.from('knowledge_documents').select('id,collection_id,file_id')
      .eq('organization_id', organizationId).in('id', ids.slice(i, i + CITATION_CHECK_BATCH)));
    for (const row of Array.isArray(rows) ? rows : []) {
      const r = row as Record<string, unknown>;
      readable.set(str(r.id), { collectionId: str(r.collection_id), fileId: str(r.file_id) });
    }
  }
  // The document must still be readable AND still be the same document in the same collection.
  const allowed = (c: MessageCitation) => { const d = readable.get(c.documentId); return !!d && d.collectionId === c.collectionId && d.fileId === c.fileId; };
  return messages.map((m) => (m.citations.length === 0 || m.citations.every(allowed) ? m : { ...m, citations: m.citations.filter(allowed) }));
}

/** The user's own message, through their RLS-bound client (role = 'user' only; 20261120200003). */
export async function appendMessage(db: ChatDb, input: {
  organizationId: string; threadId: string; role: 'user'; content: string; modelKey?: string;
  mentions?: readonly Mention[]; status?: 'complete' | 'error' | 'stopped';
}): Promise<StoredMessage> {
  // Exactly the columns authenticated may INSERT; citations/knowledge_unavailable/capability_key take their defaults.
  const data = check(await db.from('chat_messages').insert({
    organization_id: input.organizationId, thread_id: input.threadId, role: 'user', content: input.content,
    model_key: input.modelKey ?? null, mentions: input.mentions ?? [], status: input.status ?? 'complete',
  }).select(MESSAGE_COLS).single());
  return toMessage(data);
}

/**
 * An assistant or tool message, written by the server for `userId` through
 * the sso_control client (append_chat_message_server). The database re-checks
 * that userId owns the open thread and is a current member, so a wrong id can
 * never write into someone else's thread. Never pass the user's own client.
 */
export async function appendServerMessage(control: ChatDb, input: {
  organizationId: string; userId: string; threadId: string; role: 'assistant' | 'tool'; content: string; modelKey?: string;
  mentions?: readonly Mention[]; status?: 'complete' | 'error' | 'stopped'; capabilityKey?: string;
  /** Assistant messages only (ignored otherwise): the citations streamed with this turn. */
  citations?: readonly MessageCitation[]; knowledgeUnavailable?: boolean;
}): Promise<StoredMessage> {
  const assistant = input.role === 'assistant';
  const r = await control.rpc('append_chat_message_server', {
    p_organization_id: input.organizationId, p_user_id: input.userId, p_thread_id: input.threadId, p_role: input.role,
    p_content: input.content, p_status: input.status ?? 'complete', p_model_key: input.modelKey ?? null, p_mentions: input.mentions ?? [],
    p_capability_key: input.role === 'tool' ? input.capabilityKey ?? null : null,
    p_citations: assistant ? citationsForStorage(input.citations) : [],
    p_knowledge_unavailable: assistant && input.knowledgeUnavailable === true,
  });
  if (r.error?.code === 'P0002') throw new ChatStoreError('NOT_FOUND');
  return toMessage(check(r));
}

export async function touchThread(db: ChatDb, organizationId: string, threadId: string, patch: { title?: string; modelKey?: string }): Promise<void> {
  const values: Record<string, string> = { updated_at: new Date().toISOString() };
  if (patch.title) values.title = patch.title;
  if (patch.modelKey) values.model_key = patch.modelKey;
  check(await db.from('chat_threads').update(values).eq('id', threadId).eq('organization_id', organizationId));
}

export async function listCapabilities(db: ChatDb, organizationId: string): Promise<CapabilityRow[]> {
  const data = check(await db.rpc('list_chat_capabilities', { p_organization_id: organizationId }));
  return (Array.isArray(data) ? data : []).map(toCapability);
}

export function titleFrom(text: string): string {
  const t = text.replace(/@\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  return (t.length > 60 ? `${t.slice(0, 57).trimEnd()}\u2026` : t) || 'New chat';
}
