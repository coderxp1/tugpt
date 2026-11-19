/**
 * Workspace API contracts (Agent 4 backend -> Agent 3 UI).
 *
 * Browser-safe: no server imports. Every type here is the exact JSON shape a
 * route returns; docs/workspace/backend-api.md documents the same contract
 * with status codes. Errors are always `{ "error": WorkspaceErrorCode }`.
 *
 * Kept separate from Connect/MCP (/api/v1/connect/*): approvals here are the
 * request/history layer; granting/claiming stays in Agent 2's functions.
 */
import type { WorkspaceErrorCode } from './errors';
import type { AgentInput, CustomAgent } from './agents';
export type { AgentInput, AgentTool, Citation, CustomAgent } from './agents';
export type { WorkspaceErrorCode } from './errors';

export const WORKSPACE_API = {
  threads: '/api/v1/chat/threads',
  thread: (id: string) => `/api/v1/chat/threads/${encodeURIComponent(id)}`,
  threadAttachments: (id: string) => `/api/v1/chat/threads/${encodeURIComponent(id)}/attachments`,
  threadAttachment: (id: string, fileId: string) => `/api/v1/chat/threads/${encodeURIComponent(id)}/attachments/${encodeURIComponent(fileId)}`,
  threadCollections: (id: string) => `/api/v1/chat/threads/${encodeURIComponent(id)}/collections`,
  threadCollection: (id: string, collectionId: string) => `/api/v1/chat/threads/${encodeURIComponent(id)}/collections/${encodeURIComponent(collectionId)}`,
  folders: '/api/v1/chat/folders',
  folder: (id: string) => `/api/v1/chat/folders/${encodeURIComponent(id)}`,
  approvals: '/api/v1/approvals',
  approval: (id: string) => `/api/v1/approvals/${encodeURIComponent(id)}`,
  files: '/api/v1/files',
  file: (id: string) => `/api/v1/files/${encodeURIComponent(id)}`,
  fileContent: (id: string) => `/api/v1/files/${encodeURIComponent(id)}/content`,
  collections: '/api/v1/library/collections',
  collection: (id: string) => `/api/v1/library/collections/${encodeURIComponent(id)}`,
  documents: (id: string) => `/api/v1/library/collections/${encodeURIComponent(id)}/documents`,
  document: (id: string, documentId: string) => `/api/v1/library/collections/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`,
  search: '/api/v1/library/search',
  agents: '/api/v1/agents',
  agent: (id: string) => `/api/v1/agents/${encodeURIComponent(id)}`,
  agentCollections: (id: string) => `/api/v1/agents/${encodeURIComponent(id)}/collections`,
  agentCollection: (id: string, collectionId: string) => `/api/v1/agents/${encodeURIComponent(id)}/collections/${encodeURIComponent(collectionId)}`,
  /** POST, streams NDJSON (not used through the JSON client). */
  agentRun: (id: string) => `/api/v1/agents/${encodeURIComponent(id)}/run`,
} as const;

// ---------------------------------------------------------------- conversations
export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly modelKey: string;
  readonly folderId: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Only for searches: where the match was found, and a plain-text excerpt for message matches. */
  readonly matchSource: 'title' | 'message' | null;
  readonly snippet: string | null;
}
export interface ConversationQuery {
  readonly q?: string;
  readonly archived?: boolean;
  readonly folderId?: string;
  readonly unfiled?: boolean;
  readonly limit?: number;
  /** ISO timestamp cursor: return conversations updated strictly before it. */
  readonly before?: string;
}
export interface ConversationList { readonly threads: readonly Conversation[]; readonly nextCursor: string | null }
export interface ConversationPatch {
  readonly title?: string;
  readonly archived?: boolean;
  readonly folderId?: string | null;
}
export interface Folder { readonly id: string; readonly name: string; readonly createdAt: string; readonly updatedAt: string }

// ---------------------------------------------------------------- approvals
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'used' | 'revoked';
export type ApprovalSource = 'request' | 'direct';
export interface ApprovalPreviewLine { readonly path: string; readonly value: string; readonly redacted: boolean; readonly truncated: boolean }
export interface ApprovalRecord {
  readonly id: string;
  readonly source: ApprovalSource;
  readonly status: ApprovalStatus;
  readonly threadId: string | null;
  readonly requestedBy: { readonly id: string | null; readonly name: string | null };
  readonly decidedBy: { readonly id: string | null; readonly name: string | null } | null;
  readonly connectionId: string;
  readonly endpointName: string | null;
  readonly capability: string;
  readonly permissionClass: 'write' | 'irreversible' | 'financial' | null;
  readonly argumentsSha256: string;
  readonly argumentsPreview: readonly ApprovalPreviewLine[];
  readonly reason: string | null;
  readonly decisionNote: string | null;
  readonly decidedAt: string | null;
  readonly toolApprovalId: string | null;
  readonly approvalExpiresAt: string | null;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface ApprovalHistoryQuery {
  readonly scope?: 'mine' | 'org';
  readonly status?: ApprovalStatus;
  readonly limit?: number;
  readonly before?: string;
}
export interface CreateApprovalRequest {
  readonly threadId: string;
  readonly connectionId: string;
  readonly capability: string;
  /** The exact tool-call arguments. The server hashes and redacts them; raw arguments are never stored. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}
export type ApprovalAction =
  | { readonly action: 'approve'; readonly ttlSeconds?: number; readonly note?: string }
  | { readonly action: 'reject'; readonly note?: string }
  | { readonly action: 'cancel' }
  | { readonly action: 'revoke' };
export interface ApprovalActionResult {
  readonly id: string;
  readonly action: ApprovalAction['action'];
  readonly changed: boolean;
  readonly toolApprovalId: string | null;
  readonly approvalExpiresAt: string | null;
}

// ---------------------------------------------------------------- files
export type FileVisibility = 'private' | 'organization';
export interface WorkspaceFile {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly visibility: FileVisibility;
  readonly status: 'uploading' | 'ready' | 'failed';
  readonly ownedByMe: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface FileQuery { readonly scope?: 'mine' | 'organization'; readonly limit?: number; readonly before?: string }
export interface Attachment { readonly file: WorkspaceFile; readonly attachedAt: string }

// ---------------------------------------------------------------- library
export interface Collection {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: FileVisibility;
  readonly ownedByMe: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type DocumentStatus = 'pending' | 'indexing' | 'ready' | 'failed' | 'unsupported';
export interface LibraryDocument {
  readonly id: string;
  readonly collectionId: string;
  readonly fileId: string;
  readonly title: string;
  readonly status: DocumentStatus;
  /** Machine code when status is failed/unsupported, e.g. PDF_EXTRACTION_UNAVAILABLE. */
  readonly errorCode: string | null;
  readonly chunkCount: number;
  readonly indexedAt: string | null;
  readonly createdAt: string;
  /** Processing attempts so far (failed attempts are retried with backoff, max 5). */
  readonly processingAttempts: number;
  /** When a retry is scheduled after a transient failure; null otherwise. */
  readonly nextAttemptAt: string | null;
}
export interface CollectionDetail { readonly collection: Collection; readonly documents: readonly LibraryDocument[] }
export interface SearchHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly collectionId: string;
  readonly fileId: string;
  readonly title: string;
  readonly ordinal: number;
  /** Plain text, no markup. */
  readonly snippet: string;
  /** Fused rank (Reciprocal Rank Fusion); higher is better. */
  readonly rank: number;
  /** Which retriever(s) found this chunk. */
  readonly match: 'keyword' | 'semantic' | 'hybrid';
  readonly keywordScore: number | null;
  readonly semanticScore: number | null;
}
export interface SearchResult { readonly hits: readonly SearchHit[]; readonly semantic: boolean }

// ---------------------------------------------------------------- typed client
export type WorkspaceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: WorkspaceErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE' };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function query(params: Record<string, string | number | boolean | undefined | readonly string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { if (v.length) sp.set(k, v.join(',')); } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Minimal typed client. Mutations send the same-origin CSRF header the routes
 * require. Pass a custom fetch in tests or to add an organization header.
 */
export function createWorkspaceClient(fetchFn: FetchFn = (i, init) => fetch(i, init), headers: Record<string, string> = {}) {
  async function call<T>(method: string, url: string, body?: unknown, raw?: { data: Blob | ArrayBuffer | Uint8Array; type: string }): Promise<WorkspaceResult<T>> {
    const h: Record<string, string> = { accept: 'application/json', ...headers };
    if (method !== 'GET') h['x-tugpt-csrf'] = '1';
    let payload: BodyInit | undefined;
    if (raw) { h['content-type'] = raw.type; payload = raw.data as BodyInit; } else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let res: Response;
    try { res = await fetchFn(url, { method, headers: h, body: payload, credentials: 'same-origin' }); } catch { return { ok: false, status: 0, error: 'NETWORK_ERROR' }; }
    let json: unknown = null;
    try { json = res.status === 204 ? null : await res.json(); } catch { if (res.ok) return { ok: false, status: res.status, error: 'UNEXPECTED_RESPONSE' }; }
    if (!res.ok) {
      const code = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: WorkspaceErrorCode }).error : 'UNEXPECTED_RESPONSE';
      return { ok: false, status: res.status, error: code };
    }
    return { ok: true, value: json as T };
  }
  return {
    listConversations: (q: ConversationQuery = {}) => call<ConversationList>('GET', WORKSPACE_API.threads + query({ ...q, archived: q.archived ?? false })),
    updateConversation: (id: string, patch: ConversationPatch) => call<{ thread: Conversation }>('PATCH', WORKSPACE_API.thread(id), patch),
    deleteConversation: (id: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.thread(id)),
    listFolders: () => call<{ folders: readonly Folder[] }>('GET', WORKSPACE_API.folders),
    createFolder: (name: string) => call<{ folder: Folder }>('POST', WORKSPACE_API.folders, { name }),
    renameFolder: (id: string, name: string) => call<{ folder: Folder }>('PATCH', WORKSPACE_API.folder(id), { name }),
    deleteFolder: (id: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.folder(id)),
    listAttachments: (threadId: string) => call<{ attachments: readonly Attachment[] }>('GET', WORKSPACE_API.threadAttachments(threadId)),
    attachFile: (threadId: string, fileId: string) => call<{ attachment: Attachment }>('POST', WORKSPACE_API.threadAttachments(threadId), { fileId }),
    detachFile: (threadId: string, fileId: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.threadAttachment(threadId, fileId)),
    listThreadCollections: (threadId: string) => call<{ collections: readonly Collection[] }>('GET', WORKSPACE_API.threadCollections(threadId)),
    linkCollection: (threadId: string, collectionId: string) => call<{ linked: true }>('POST', WORKSPACE_API.threadCollections(threadId), { collectionId }),
    unlinkCollection: (threadId: string, collectionId: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.threadCollection(threadId, collectionId)),

    listApprovals: (q: ApprovalHistoryQuery = {}) => call<{ approvals: readonly ApprovalRecord[]; nextCursor: string | null }>('GET', WORKSPACE_API.approvals + query({ ...q })),
    createApprovalRequest: (input: CreateApprovalRequest) => call<{ approval: ApprovalRecord }>('POST', WORKSPACE_API.approvals, input),
    getApproval: (id: string) => call<{ approval: ApprovalRecord }>('GET', WORKSPACE_API.approval(id)),
    actOnApproval: (id: string, action: ApprovalAction) => call<ApprovalActionResult>('POST', WORKSPACE_API.approval(id), action),

    listFiles: (q: FileQuery = {}) => call<{ files: readonly WorkspaceFile[]; nextCursor: string | null }>('GET', WORKSPACE_API.files + query({ ...q })),
    uploadFile: (file: Blob, filename: string, visibility: FileVisibility = 'private') =>
      call<{ file: WorkspaceFile }>('POST', WORKSPACE_API.files + query({ filename, visibility }), undefined, { data: file, type: file.type || 'application/octet-stream' }),
    getFile: (id: string) => call<{ file: WorkspaceFile }>('GET', WORKSPACE_API.file(id)),
    renameFile: (id: string, filename: string) => call<{ file: WorkspaceFile }>('PATCH', WORKSPACE_API.file(id), { filename }),
    deleteFile: (id: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.file(id)),
    /** Use as an <a href download> target; the route sets Content-Disposition: attachment. */
    fileContentUrl: (id: string) => WORKSPACE_API.fileContent(id),

    listCollections: () => call<{ collections: readonly Collection[] }>('GET', WORKSPACE_API.collections),
    createCollection: (input: { name: string; description?: string; visibility?: FileVisibility }) => call<{ collection: Collection }>('POST', WORKSPACE_API.collections, input),
    getCollection: (id: string) => call<CollectionDetail>('GET', WORKSPACE_API.collection(id)),
    updateCollection: (id: string, patch: { name?: string; description?: string | null; visibility?: FileVisibility }) => call<{ collection: Collection }>('PATCH', WORKSPACE_API.collection(id), patch),
    deleteCollection: (id: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.collection(id)),
    addDocument: (collectionId: string, fileId: string, title?: string) => call<{ document: LibraryDocument; created?: boolean }>('POST', WORKSPACE_API.documents(collectionId), { fileId, title }),
    reindexDocument: (collectionId: string, documentId: string) => call<{ document: LibraryDocument }>('POST', WORKSPACE_API.document(collectionId, documentId), { action: 'reindex' }),
    removeDocument: (collectionId: string, documentId: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.document(collectionId, documentId)),
    search: (q: string, opts: { collectionIds?: readonly string[]; limit?: number } = {}) =>
      call<SearchResult>('GET', WORKSPACE_API.search + query({ q, collectionIds: opts.collectionIds, limit: opts.limit })),

    listAgents: () => call<{ agents: readonly CustomAgent[] }>('GET', WORKSPACE_API.agents),
    createAgent: (input: AgentInput & { name: string; instructions: string }) => call<{ agent: CustomAgent }>('POST', WORKSPACE_API.agents, input),
    getAgent: (id: string) => call<{ agent: CustomAgent }>('GET', WORKSPACE_API.agent(id)),
    /** Partial update. The whole agent as returned may be sent back: read-only fields are ignored. */
    updateAgent: (id: string, patch: AgentInput | (AgentInput & Partial<CustomAgent>)) => call<{ agent: CustomAgent }>('PATCH', WORKSPACE_API.agent(id), patch),
    deleteAgent: (id: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.agent(id)),
    listAgentCollections: (id: string) => call<{ collections: readonly Collection[] }>('GET', WORKSPACE_API.agentCollections(id)),
    linkAgentCollection: (id: string, collectionId: string) => call<{ linked: true }>('POST', WORKSPACE_API.agentCollections(id), { collectionId }),
    unlinkAgentCollection: (id: string, collectionId: string) => call<{ deleted: true }>('DELETE', WORKSPACE_API.agentCollection(id, collectionId)),
  };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
