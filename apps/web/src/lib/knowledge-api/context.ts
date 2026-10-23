// Knowledge management API — shared context resolution.
//
// Every knowledge route runs the same gauntlet as the draft routes:
// session → tenant → the ai_draft_generation feature gate (knowledge
// exists to ground drafts; it is managed under the same switch).
// Data operations then run on the SESSION client, so the
// knowledge_entries RLS policies (migration 20261022000004) are the
// authorization layer: members read, owner/admin write, and no route
// here can see or touch another organization's entries — the
// organization filter is applied as well, as defense in depth and
// to keep result shaping deterministic.

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import type { ApiError } from '@/lib/draft-api/types';

export interface KnowledgeEntryRow {
  id: string;
  organization_id: string;
  question: string;
  answer: string;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  userId: string;
  organizationId: string;
  requestId: string;
}

export function knowledgeError(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function resolveKnowledgeContext(
  request: Request
): Promise<{ context: KnowledgeContext } | { response: NextResponse }> {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  const supabase = await createAuthenticatedServerClient();
  const authService = new AuthService(supabase);
  const user = await authService.getCurrentUser();
  if (!user) {
    return {
      response: knowledgeError(401, 'UNAUTHENTICATED', 'Authentication required'),
    };
  }

  const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
  if (!activeTenant) {
    return {
      response: knowledgeError(403, 'FORBIDDEN', 'No active organization found'),
    };
  }

  const adminClient = createAdminSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const gate = await checkDraftFeatureGate(adminClient, activeTenant.organizationId);
  if (!gate.allowed) {
    return {
      response: knowledgeError(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message),
    };
  }

  return {
    context: {
      supabase,
      userId: user.id,
      organizationId: activeTenant.organizationId,
      requestId,
    },
  };
}

/** Map a PostgREST error from a knowledge write to an API response. */
export function knowledgeWriteError(error: { code?: string }): NextResponse {
  // RLS WITH CHECK / policy refusal.
  if (error.code === '42501') {
    return knowledgeError(
      403,
      'FORBIDDEN',
      'Only organization owners and admins can change knowledge entries'
    );
  }
  return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

export const QUESTION_MAX = 300;
export const ANSWER_MAX = 4000;

export function parseEntryText(
  value: unknown,
  max: number
): { text: string } | { error: string } {
  if (typeof value !== 'string') {
    return { error: 'must be a string' };
  }
  const text = value.trim();
  if (text.length === 0) {
    return { error: 'must not be empty' };
  }
  if (text.length > max) {
    return { error: `must be at most ${max} characters` };
  }
  return { text };
}
