/**
 * What the Dashboard hub is allowed to say about the active organization.
 *
 * Every number here is read through the signed-in user's own Supabase client,
 * so row-level security decides what is counted — the hub can never show a
 * figure the same person could not see on the page it links to. Counts use
 * `head: true`: no row content crosses the wire, only the total.
 *
 * Each signal fails independently to `null`, and the UI renders `null` as
 * "unavailable", never as zero. A dashboard that shows "0 waiting" because a
 * query failed is lying in the most dangerous direction: it tells a reviewer
 * nobody needs them.
 *
 * Held capabilities have no status lookups. Feature queries use the narrow
 * session-bound adapter, not privileged credentials; they may take DB locks.
 */

import type { TypedSupabaseClient } from '@tugpt/database';
import { createFeatureServerClient } from '@/lib/supabase/server';

export interface HubSignals {
  /** Existing server-side feature gate; never enables or changes it. */
  readonly draftFeatureEnabled?: boolean | null;
  readonly mediaFeatureEnabled?: boolean | null;
  /** Conversations a human has been asked to take over. */
  readonly needsHuman: number | null;
  /** Conversations still open (including those needing a human). */
  readonly openConversations: number | null;
  /** AI drafts waiting for review. */
  readonly draftsAwaitingReview: number | null;
  /** Knowledge entries the drafts can be grounded in. */
  readonly knowledgeEntries: number | null;
  /** Media jobs queued or processing. */
  readonly activeMediaJobs: number | null;
  /** WhatsApp connection state for this organization. */
  readonly whatsapp: 'active' | 'pending' | 'error' | 'none' | null;
  /** Google Calendar connection, from the existing status helper. */
  readonly calendar: 'connected' | 'expired' | 'available' | 'unconfigured' | null;
}

export const UNAVAILABLE_SIGNALS: HubSignals = {
  draftFeatureEnabled: null,
  mediaFeatureEnabled: null,
  needsHuman: null,
  openConversations: null,
  draftsAwaitingReview: null,
  knowledgeEntries: null,
  activeMediaJobs: null,
  whatsapp: null,
  calendar: null,
};

/**
 * Narrow structural view of the query builder. `knowledge_entries` and
 * `media_generation_jobs` predate their entries in the generated types, so the
 * typed client cannot name them yet.
 */
interface CountQuery extends PromiseLike<{ count: number | null; error: unknown }> {
  eq(column: string, value: string): CountQuery;
  in(column: string, values: readonly string[]): CountQuery;
}
interface RowsQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(column: string, value: string): RowsQuery;
  limit(n: number): RowsQuery;
}
interface LooseClient {
  from(table: string): {
    select(columns: string, options: { count: 'exact'; head: true }): CountQuery;
    select(columns: string): RowsQuery;
  };
}

async function countOf(query: CountQuery): Promise<number | null> {
  try {
    const { count, error } = await query;
    return error || typeof count !== 'number' ? null : count;
  } catch {
    return null;
  }
}

/** Collapse any number of connection rows into the one state worth showing. */
export function summarizeWhatsapp(rows: unknown): HubSignals['whatsapp'] {
  if (!Array.isArray(rows)) return null;
  const statuses = rows
    .map((r) => (r && typeof r === 'object' ? (r as { status?: unknown }).status : null))
    .filter((s): s is string => typeof s === 'string');
  if (statuses.includes('active')) return 'active';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('pending')) return 'pending';
  return 'none';
}

async function featureState(organizationId: string): Promise<boolean | null> {
  try {
    const feature = await createFeatureServerClient(organizationId);
    const { data, error } = await feature.rpc('is_feature_enabled', {
      p_organization_id: organizationId, p_flag_key: 'ai_draft_generation',
    });
    return error || typeof data !== 'boolean' ? null : data;
  } catch { return null; }
}

export async function loadHubSignals(
  db: TypedSupabaseClient,
  organizationId: string
): Promise<HubSignals> {
  const loose = db as unknown as LooseClient;
  const count = (table: string) => loose.from(table).select('id', { count: 'exact', head: true });

  const [needsHuman, openConversations, draftsAwaitingReview, knowledgeEntries, draftFeatureEnabled] =
    await Promise.all([
      countOf(count('conversations').eq('organization_id', organizationId).eq('status', 'needs_human')),
      countOf(count('conversations').eq('organization_id', organizationId).in('status', ['open', 'needs_human'])),
      countOf(count('ai_drafts').eq('organization_id', organizationId).eq('status', 'draft')),
      countOf(count('knowledge_entries').eq('organization_id', organizationId)),
      featureState(organizationId),
    ]);

  return { needsHuman, openConversations, draftsAwaitingReview, knowledgeEntries, draftFeatureEnabled,
    activeMediaJobs: null, whatsapp: null, calendar: null, mediaFeatureEnabled: null };
}
