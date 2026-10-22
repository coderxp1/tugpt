// Stage 5A: API response types for the draft review dashboard

import type { DeliveryView } from './delivery-status';

export interface DraftListItem {
  id: string;
  status: 'draft' | 'approved' | 'rejected';
  version: number;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  rejected_at: string | null;
  source_message_preview: string | null;
  current_revision_body_preview: string | null;
  source_message_id?: string;
  /**
   * Outbound delivery state, attached by the list route when a
   * delivery exists for this draft (approved drafts only). Absent or
   * null means no delivery — the UI shows no delivery badge.
   */
  delivery?: DeliveryView | null;
}

export interface DraftSourceMessage {
  body: string | null;
  direction: 'inbound' | 'outbound';
  created_at: string;
  contact_display: string | null;
}

export interface DraftConversationContext {
  id: string;
  /**
   * Masked, never the raw number — see `contact-display.ts`.
   *
   * This was `contact_phone: string`, the full number, sent to the browser on
   * every draft-detail request and rendered nowhere. Renaming rather than
   * masking in place is deliberate: a field called `contact_phone` invites the
   * next caller to treat it as one.
   */
  contact_display: string | null;
  status: 'open' | 'needs_human' | 'closed';
}

/** One message in a conversation, as a reviewer sees it. */
export interface ThreadMessage {
  id: string;
  body: string | null;
  direction: 'inbound' | 'outbound';
  created_at: string;
  /**
   * True for the message this draft is answering.
   *
   * The point of the thread view is reading the history *around* that message;
   * a thread that does not say which one it is has lost the thing it is for.
   */
  is_source: boolean;
}

/** A bounded window onto a conversation, anchored by the draft being reviewed. */
export interface ConversationThread {
  conversation_id: string;
  contact_display: string | null;
  status: 'open' | 'needs_human' | 'closed';
  /** Oldest first — reading order, not query order. */
  messages: ThreadMessage[];
  /** True when the conversation has messages older than the window. */
  has_more: boolean;
  /**
   * False when the message this draft answers is older than the window.
   *
   * Rare — a draft is generated from a recent message — but silent if it were
   * not reported: the reviewer would read a history that does not contain the
   * message being answered and have no way to tell. The draft's own source
   * message is rendered separately above the thread, so nothing is hidden; the
   * UI just has to say that the two are not contiguous.
   */
  source_in_window: boolean;
}

export interface DraftDetail {
  id: string;
  status: 'draft' | 'approved' | 'rejected';
  version: number;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  current_revision_body: string | null;
  source_message: DraftSourceMessage | null;
  conversation: DraftConversationContext | null;
}

export interface Revision {
  id: string;
  version: number;
  body: string;
  created_by_type: 'system' | 'user';
  created_by_user_id: string | null;
  created_at: string;
}

export interface ReviewEvent {
  id: string;
  action: 'approve' | 'edit' | 'reject';
  actor_id: string;
  previous_version: number;
  new_version: number;
  created_at: string;
}

export interface DraftListResponse {
  drafts: DraftListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DraftDetailResponse {
  draft: DraftDetail;
}

export interface RevisionListResponse {
  revisions: Revision[];
}

export interface ReviewEventListResponse {
  events: ReviewEvent[];
}

export interface DraftActionResponse {
  draft: {
    id: string;
    status: string;
    version: number;
    reviewed_at?: string | null;
    reviewed_by?: string | null;
    rejected_at?: string | null;
    rejected_by?: string | null;
    current_revision_id?: string | null;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}