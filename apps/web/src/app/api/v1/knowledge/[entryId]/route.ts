// Knowledge entry — update and delete one entry.
//
// PATCH  /api/v1/knowledge/:entryId — edit question/answer and/or
//        the enabled flag. Partial: omitted fields keep their
//        values. Owner/admin only (RLS); a cross-organization id
//        updates zero rows and returns the same 404 as a missing
//        entry, so ids cannot be probed across tenants.
// DELETE /api/v1/knowledge/:entryId — remove the entry, same
//        visibility semantics.

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> }
) {
  const { entryId } = await params;
  if (!UUID_REGEX.test(entryId)) {
    return knowledgeError(400, 'INVALID_UUID', 'Invalid entry ID format');
  }

  const resolved = await resolveKnowledgeContext(request);
  if ('response' in resolved) return resolved.response;
  const { supabase, organizationId, requestId } = resolved.context;

  try {
    const body = (await request.json().catch(() => null)) as
      | { question?: unknown; answer?: unknown; enabled?: unknown }
      | null;
    if (!body) {
      return knowledgeError(400, 'VALIDATION_ERROR', 'A JSON body is required');
    }

    const patch: { question?: string; answer?: string; enabled?: boolean } = {};
    if (body.question !== undefined) {
      const question = parseEntryText(body.question, QUESTION_MAX);
      if ('error' in question) {
        return knowledgeError(400, 'VALIDATION_ERROR', `question ${question.error}`);
      }
      patch.question = question.text;
    }
    if (body.answer !== undefined) {
      const answer = parseEntryText(body.answer, ANSWER_MAX);
      if ('error' in answer) {
        return knowledgeError(400, 'VALIDATION_ERROR', `answer ${answer.error}`);
      }
      patch.answer = answer.text;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return knowledgeError(400, 'VALIDATION_ERROR', 'enabled must be a boolean');
      }
      patch.enabled = body.enabled;
    }
    if (Object.keys(patch).length === 0) {
      return knowledgeError(400, 'VALIDATION_ERROR', 'Nothing to update');
    }

    const { data, error } = await supabase
      .from('knowledge_entries')
      .update(patch)
      .eq('id', entryId)
      .eq('organization_id', organizationId)
      .select('id, organization_id, question, answer, enabled, created_by, created_at, updated_at');

    if (error) {
      return knowledgeWriteError(error);
    }
    const rows = (data ?? []) as KnowledgeEntryRow[];
    if (rows.length === 0) {
      return knowledgeError(404, 'KNOWLEDGE_ENTRY_NOT_FOUND', 'Knowledge entry not found');
    }

    return NextResponse.json({ entry: rows[0] });
  } catch (err) {
    defaultLogger.error('Knowledge update failed', err as Error, { requestId });
    return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> }
) {
  const { entryId } = await params;
  if (!UUID_REGEX.test(entryId)) {
    return knowledgeError(400, 'INVALID_UUID', 'Invalid entry ID format');
  }

  const resolved = await resolveKnowledgeContext(request);
  if ('response' in resolved) return resolved.response;
  const { supabase, organizationId, requestId } = resolved.context;

  try {
    const { data, error } = await supabase
      .from('knowledge_entries')
      .delete()
      .eq('id', entryId)
      .eq('organization_id', organizationId)
      .select('id');

    if (error) {
      return knowledgeWriteError(error);
    }
    if (!data || data.length === 0) {
      return knowledgeError(404, 'KNOWLEDGE_ENTRY_NOT_FOUND', 'Knowledge entry not found');
    }

    return NextResponse.json({ deleted: true });
  } catch (err) {
    defaultLogger.error('Knowledge delete failed', err as Error, { requestId });
    return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
