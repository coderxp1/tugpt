import { isMissingColumn, isMissingFunction, isMissingTable } from '@/lib/supabase/schema-compat';
import { publicCapabilityId } from './models';

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
/** The PostgREST builder also has lt(); only loadTurn needs it, so test fakes of DbQuery need not implement it. */
interface RangeQuery extends DbQuery { lt(column: string, value: unknown): DbQuery }
export interface ChatDb {
  from(table: string): { select(columns: string): DbQuery; insert(values: object): DbQuery; update(values: object): DbQuery };
  rpc(fn: string, args: object): PromiseLike<DbResult>;
}
export function asChatDb(client: unknown): ChatDb { return client as ChatDb; }

export class ChatStoreError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'NOT_FOUND' | 'FORBIDDEN' | 'TURN_EXISTS' | 'TURNS_UNSUPPORTED') { super(code); this.name = 'ChatStoreError'; }
}

/** agentId: the custom agent the thread was started with; null for plain chat or once that agent was deleted. */
/** `modelKey` and `capabilityId` both carry the opaque capability id (CONF-1); the stored routing key never leaves the server. */
export interface ThreadSummary { readonly id: string; readonly title: string; readonly modelKey: string; readonly capabilityId: string; readonly updatedAt: string; readonly agentId: string | null }
/**
 * citations / knowledgeUnavailable: what an agent turn streamed with this assistant answer (20261120100010).
 * Always [] / false for user and tool messages and for plain chat.
 */
export interface StoredMessage {
  readonly id: string; readonly role: 'user' | 'assistant' | 'tool'; readonly content: string;
  readonly createdAt: string; readonly status: 'complete' | 'error' | 'stopped';
  readonly mentions: readonly Mention[]; readonly capabilityKey: string | null;
  readonly citations: readonly MessageCitation[]; readonly knowledgeUnavailable: boolean;
  /** The turn this message belongs to (Q-12, 20261121100001); null for messages sent without a turn id. */
  readonly turnId?: string | null;
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
  const capabilityId = publicCapabilityId(str(r.model_key)) ?? '';
  return { id: str(r.id), title: str(r.title), modelKey: capabilityId, capabilityId, updatedAt: str(r.updated_at), agentId: optStr(r.agent_id) };
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
    turnId: optStr(r.turn_id),
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
/** MESSAGE_COLS plus turn_id (20261121100001); see isMissingColumn for databases without it. */
const MESSAGE_TURN_COLS = `${MESSAGE_COLS},turn_id`;
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
/** The most recent messages a thread read returns (and the citations RPC's id cap). */
export const THREAD_MESSAGE_LIMIT = 400;

export async function listMessages(db: ChatDb, organizationId: string, threadId: string): Promise<StoredMessage[]> {
  // The LATEST messages, oldest first. (Before Q-13 this read the oldest 400, so a long thread lost its
  // recent messages in the view, in the model's history and in turn lookups.)
  const page = (cols: string) => db.from('chat_messages').select(cols)
    .eq('thread_id', threadId).eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(THREAD_MESSAGE_LIMIT);
  let res = await page(MESSAGE_TURN_COLS);
  if (isMissingColumn(res.error)) res = await page(MESSAGE_COLS); // pre-Q-12 schema: no turn ids
  const data = check(res);
  const raw = ((Array.isArray(data) ? data : []) as Record<string, unknown>[]).reverse();
  return withCitations(db, organizationId, threadId, raw);
}

/**
 * Assistant answers already stored for a turn (USAGE-1: the attempt number of the next run).
 * null when it cannot be read; callers then record no usage rather than reuse an index.
 */
export async function countTurnAnswers(db: ChatDb, organizationId: string, threadId: string, turnId: string): Promise<number | null> {
  try {
    const r = await db.from('chat_messages').select('id')
      .eq('thread_id', threadId).eq('organization_id', organizationId).eq('turn_id', turnId).eq('role', 'assistant').limit(64);
    if (r.error || !Array.isArray(r.data)) return null;
    return r.data.length;
  } catch { return null; }
}

/** Parses rows and attaches their citations, re-authorised for the reader (see listMessages). */
async function withCitations(db: ChatDb, organizationId: string, threadId: string, raw: readonly Record<string, unknown>[]): Promise<StoredMessage[]> {
  // Only assistant messages can carry citations; callers pass at most THREAD_MESSAGE_LIMIT rows (the RPC's id cap).
  const cited = raw.filter((r) => r.role === 'assistant').map((r) => str(r.id));
  const citations = new Map<string, unknown>();
  if (cited.length > 0) {
    const r = await db.rpc('chat_message_citations', { p_organization_id: organizationId, p_thread_id: threadId, p_message_ids: cited });
    if (isMissingFunction(r.error)) {
      // Pre-Q-9c schema only (see schema-compat): the column is still readable to the thread owner there,
      // and authorizeCitations below applies the same per-document rule as before Q-9c.
      const legacy = check(await db.from('chat_messages').select('id,citations')
        .eq('thread_id', threadId).eq('organization_id', organizationId).in('id', cited));
      for (const row of Array.isArray(legacy) ? legacy : []) {
        const x = row as Record<string, unknown>;
        citations.set(str(x.id), x.citations);
      }
    } else {
      const fromRpc = check(r);
      for (const row of Array.isArray(fromRpc) ? fromRpc : []) {
        const x = row as Record<string, unknown>;
        citations.set(str(x.message_id), x.citations);
      }
    }
  }
  return authorizeCitations(db, organizationId, raw.map((r) => toMessage({ ...r, citations: citations.get(str(r.id)) ?? [] })));
}

/** A turn's live run as the owner sees it (20261122100001); the run token is never readable by clients. */
export interface TurnRunInfo { readonly claimedAt: string; readonly expiresAt: string }

/** One turn read by indexed lookups (Q-13): independent of how long the thread is. */
export interface TurnParts {
  readonly turnId: string;
  readonly userMessage: StoredMessage;
  /** The turn's latest assistant message (a retried turn has several), with citations re-authorised. */
  readonly latestAnswer: StoredMessage | null;
  /** True when no user message was sent after this turn's (only that turn can be retried). */
  readonly latest: boolean;
  /** Messages before the user message, oldest first (only with withHistory; no citations: model history only). */
  readonly before: readonly StoredMessage[];
  /** The live or expired run row; null when none. */
  readonly run: TurnRunInfo | null;
  /** False on a database without chat_turn_runs (pre-Q-13): run is then unknown, not absent. */
  readonly runsSupported: boolean;
}

/**
 * Loads one turn under the caller's RLS. null when the turn was never stored in this
 * thread, or the database has no turn ids yet (pre-Q-12: every send is then turn-less).
 */
export async function loadTurn(db: ChatDb, organizationId: string, threadId: string, turnId: string,
  opts: { withHistory?: boolean } = {}): Promise<TurnParts | null> {
  const inThread = (cols: string) => db.from('chat_messages').select(cols).eq('thread_id', threadId).eq('organization_id', organizationId);
  const u = await inThread(MESSAGE_TURN_COLS).eq('turn_id', turnId).eq('role', 'user').maybeSingle();
  if (isMissingColumn(u.error)) return null;
  const userRow = check(u) as Record<string, unknown> | null;
  if (!userRow) return null;
  const userMessage = toMessage({ ...userRow, citations: [] });
  const [answers, lastUser, runRes, beforeRes] = await Promise.all([
    inThread(MESSAGE_TURN_COLS).eq('turn_id', turnId).eq('role', 'assistant').order('created_at', { ascending: false }).limit(1),
    inThread('id').eq('role', 'user').order('created_at', { ascending: false }).limit(1),
    db.from('chat_turn_runs').select('claimed_at,expires_at').eq('thread_id', threadId).eq('turn_id', turnId).maybeSingle(),
    opts.withHistory
      ? (inThread(MESSAGE_TURN_COLS) as RangeQuery).lt('created_at', userMessage.createdAt).order('created_at', { ascending: false }).limit(THREAD_MESSAGE_LIMIT)
      : Promise.resolve({ data: [], error: null } as DbResult),
  ]);
  const answerRows = (check(answers) as Record<string, unknown>[] | null) ?? [];
  const [latestAnswer = null] = await withCitations(db, organizationId, threadId, answerRows.slice(0, 1));
  const lastUserRows = (check(lastUser) as Record<string, unknown>[] | null) ?? [];
  const runsSupported = !isMissingTable(runRes.error);
  const runRow = runsSupported ? (check(runRes) as Record<string, unknown> | null) : null;
  const beforeRows = ((check(beforeRes) as Record<string, unknown>[] | null) ?? []).reverse();
  return {
    turnId, userMessage, latestAnswer,
    latest: lastUserRows.length > 0 && str(lastUserRows[0].id) === userMessage.id,
    before: beforeRows.map((r) => toMessage({ ...r, citations: [] })),
    run: runRow ? { claimedAt: str(runRow.claimed_at), expiresAt: str(runRow.expires_at) } : null,
    runsSupported,
  };
}

export type ClaimOutcome =
  | { readonly outcome: 'claimed'; readonly runId: string }
  | { readonly outcome: 'busy' | 'stale' | 'not_latest' | 'unsupported' };

/**
 * Takes the turn's run lease on the sso_control client (claim_chat_turn_run_server). The database
 * re-checks owner, tenant, membership and that the turn exists in this thread (else NOT_FOUND).
 * 'unsupported': the database predates 20261122100001 (no lease; Q-12 behaviour).
 */
export async function claimTurnRun(control: ChatDb, input: {
  organizationId: string; userId: string; threadId: string; turnId: string;
  expectedAnswerId: string | null; requireLatest: boolean;
}): Promise<ClaimOutcome> {
  const r = await control.rpc('claim_chat_turn_run_server', {
    p_organization_id: input.organizationId, p_user_id: input.userId, p_thread_id: input.threadId, p_turn_id: input.turnId,
    p_expected_answer_id: input.expectedAnswerId, p_require_latest: input.requireLatest, p_ttl_seconds: TURN_RUN_TTL_SECONDS,
  });
  if (isMissingFunction(r.error)) return { outcome: 'unsupported' };
  if (r.error?.code === 'P0002') throw new ChatStoreError('NOT_FOUND');
  const v = check(r) as Record<string, unknown> | null;
  const outcome = v?.outcome;
  if (outcome === 'claimed' && typeof v?.run_id === 'string') return { outcome, runId: v.run_id };
  if (outcome === 'busy' || outcome === 'stale' || outcome === 'not_latest') return { outcome };
  throw new ChatStoreError('STORE_UNAVAILABLE');
}

/** Above the routes' maxDuration (120 s), so a live request never loses its lease. */
export const TURN_RUN_TTL_SECONDS = 150;

/** Releases the caller's own lease; never throws (an unreleased lease simply expires). */
export async function releaseTurnRun(control: ChatDb, input: {
  organizationId: string; userId: string; threadId: string; turnId: string; runId: string;
}): Promise<boolean> {
  try {
    const r = await control.rpc('release_chat_turn_run_server', {
      p_organization_id: input.organizationId, p_user_id: input.userId, p_thread_id: input.threadId,
      p_turn_id: input.turnId, p_run_id: input.runId,
    });
    return !r.error && r.data === true;
  } catch { return false; }
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
  /** Opens this turn (Q-12). A second user message for the same turn fails with TURN_EXISTS (unique index). */
  turnId?: string;
}): Promise<StoredMessage> {
  // Exactly the columns authenticated may INSERT; citations/knowledge_unavailable/capability_key take their defaults.
  const row = {
    organization_id: input.organizationId, thread_id: input.threadId, role: 'user', content: input.content,
    model_key: input.modelKey ?? null, mentions: input.mentions ?? [], status: input.status ?? 'complete',
  };
  if (!input.turnId) return toMessage(check(await db.from('chat_messages').insert(row).select(MESSAGE_COLS).single()));
  const r = await db.from('chat_messages').insert({ ...row, turn_id: input.turnId }).select(MESSAGE_TURN_COLS).single();
  if (r.error?.code === '23505') throw new ChatStoreError('TURN_EXISTS');
  if (isMissingColumn(r.error)) throw new ChatStoreError('TURNS_UNSUPPORTED');
  return toMessage(check(r));
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
  /** The turn this message answers (Q-12); its user message must already exist in the thread. */
  turnId?: string | null;
}, legacy?: ChatDb): Promise<StoredMessage> {
  const assistant = input.role === 'assistant';
  const args = {
    p_organization_id: input.organizationId, p_user_id: input.userId, p_thread_id: input.threadId, p_role: input.role,
    p_content: input.content, p_status: input.status ?? 'complete', p_model_key: input.modelKey ?? null, p_mentions: input.mentions ?? [],
    p_capability_key: input.role === 'tool' ? input.capabilityKey ?? null : null,
    p_citations: assistant ? citationsForStorage(input.citations) : [],
    p_knowledge_unavailable: assistant && input.knowledgeUnavailable === true,
  };
  let r = input.turnId
    ? await control.rpc('append_chat_turn_message_server', { ...args, p_turn_id: input.turnId })
    : await control.rpc('append_chat_message_server', args);
  // A turn id only exists where 20261121100001 is applied, so this is unreachable in practice; stay turn-less if it happens.
  if (input.turnId && isMissingFunction(r.error)) r = await control.rpc('append_chat_message_server', args);
  if (r.error?.code === 'P0002') throw new ChatStoreError('NOT_FOUND');
  if (isMissingFunction(r.error) && legacy) {
    // Pre-Q-9c schema only (see schema-compat): there the owner's own client may still insert these rows.
    return toMessage(check(await legacy.from('chat_messages').insert({
      organization_id: input.organizationId, thread_id: input.threadId, role: input.role, content: input.content,
      model_key: input.modelKey ?? null, mentions: input.mentions ?? [], status: input.status ?? 'complete',
      capability_key: input.role === 'tool' ? input.capabilityKey ?? null : null,
      citations: assistant ? citationsForStorage(input.citations) : [],
      knowledge_unavailable: assistant && input.knowledgeUnavailable === true,
    }).select(`${MESSAGE_COLS},citations`).single()));
  }
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
