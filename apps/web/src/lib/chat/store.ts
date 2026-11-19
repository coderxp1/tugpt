/**
 * Chat persistence through the caller's own RLS-bound client.
 *
 * There is no service-role path: what a user can read or write here is
 * exactly what 20261115000001's policies allow. Rows come back as `unknown`
 * and are parsed, so a schema drift fails loudly instead of rendering junk.
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
const MESSAGE_COLS = 'id,role,content,created_at,status,mentions,capability_key,citations,knowledge_unavailable';
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
 * snapshot, not a grant: each cited document is looked up again under the
 * READER's RLS and citations of documents they can no longer read (collection
 * made private, document removed) are left out. The remaining ones keep their
 * original n, so [n] markers in the answer still point at the right source.
 */
export async function listMessages(db: ChatDb, organizationId: string, threadId: string): Promise<StoredMessage[]> {
  const data = check(await db.from('chat_messages').select(MESSAGE_COLS)
    .eq('thread_id', threadId).eq('organization_id', organizationId).order('created_at', { ascending: true }).limit(400));
  return authorizeCitations(db, organizationId, (Array.isArray(data) ? data : []).map(toMessage));
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

export async function appendMessage(db: ChatDb, input: {
  organizationId: string; threadId: string; role: 'user' | 'assistant' | 'tool'; content: string; modelKey?: string;
  mentions?: readonly Mention[]; status?: 'complete' | 'error' | 'stopped'; capabilityKey?: string;
  /** Assistant messages only (ignored otherwise): the citations streamed with this turn. */
  citations?: readonly MessageCitation[]; knowledgeUnavailable?: boolean;
}): Promise<StoredMessage> {
  const assistant = input.role === 'assistant';
  const data = check(await db.from('chat_messages').insert({
    organization_id: input.organizationId, thread_id: input.threadId, role: input.role, content: input.content,
    model_key: input.modelKey ?? null, mentions: input.mentions ?? [], status: input.status ?? 'complete',
    capability_key: input.role === 'tool' ? input.capabilityKey ?? null : null,
    citations: assistant ? citationsForStorage(input.citations) : [],
    knowledge_unavailable: assistant && input.knowledgeUnavailable === true,
  }).select(MESSAGE_COLS).single());
  return toMessage(data);
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
