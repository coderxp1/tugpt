// Knowledge entries — list and create.
//
// GET  /api/v1/knowledge — the active organization's entries
//      (members may read; RLS is the enforcement, the organization
//      filter keeps the shape deterministic).
// POST /api/v1/knowledge — create an entry. Owner/admin only, and
//      that is enforced by the table's RLS WITH CHECK on the
//      session client: an agent's insert comes back 42501 and is
//      mapped to 403. There is deliberately no role check in
//      TypeScript duplicating the policy — one source of truth,
//      in the database, where it also governs every other client.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import {
  resolveKnowledgeContext,
  knowledgeError,
  knowledgeWriteError,
  parseEntryText,
  QUESTION_MAX,
  ANSWER_MAX,
  type KnowledgeEntryRow,
} from '@/lib/knowledge-api/context';

export async function GET(request: Request) {
  const resolved = await resolveKnowledgeContext(request);
  if ('response' in resolved) return resolved.response;
  const { supabase, organizationId, requestId } = resolved.context;

  try {
    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('id, organization_id, question, answer, enabled, created_by, created_at, updated_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) {
      defaultLogger.warn('Knowledge list failed', {
        requestId,
        organizationId,
        sqlstateCode: error.code,
      });
      return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    return NextResponse.json({ entries: (data ?? []) as KnowledgeEntryRow[] });
  } catch (err) {
    defaultLogger.error('Knowledge list failed', err as Error, { requestId });
    return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

export async function POST(request: Request) {
  const resolved = await resolveKnowledgeContext(request);
  if ('response' in resolved) return resolved.response;
  const { supabase, userId, organizationId, requestId } = resolved.context;

  try {
    const body = (await request.json().catch(() => null)) as
      | { question?: unknown; answer?: unknown }
      | null;
    if (!body) {
      return knowledgeError(400, 'VALIDATION_ERROR', 'A JSON body is required');
    }

    const question = parseEntryText(body.question, QUESTION_MAX);
    if ('error' in question) {
      return knowledgeError(400, 'VALIDATION_ERROR', `question ${question.error}`);
    }
    const answer = parseEntryText(body.answer, ANSWER_MAX);
    if ('error' in answer) {
      return knowledgeError(400, 'VALIDATION_ERROR', `answer ${answer.error}`);
    }

    const { data, error } = await supabase
      .from('knowledge_entries')
      .insert({
        organization_id: organizationId,
        question: question.text,
        answer: answer.text,
        enabled: true,
        created_by: userId,
      })
      .select('id, organization_id, question, answer, enabled, created_by, created_at, updated_at')
      .single();

    if (error) {
      return knowledgeWriteError(error);
    }

    return NextResponse.json(
      { entry: data as KnowledgeEntryRow },
      { status: 201 }
    );
  } catch (err) {
    defaultLogger.error('Knowledge create failed', err as Error, { requestId });
    return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
