// Knowledge retrieval preview — "what would the assistant use
// for this customer question?"
//
// POST /api/v1/knowledge/preview { question }
//
// Runs the SAME selection the draft worker runs in production —
// selectKnowledgeEntries from @tugpt/database, the shared module
// both sides import — over the active organization's ENABLED
// entries. The owner can therefore trust the answer: if an entry
// is not selected here, it will not be in the draft either; if
// nothing is selected, the draft for that question is generated
// without knowledge and the anti-invention guardrail governs it.
// Read-only; any member may preview.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { selectKnowledgeEntries } from '@tugpt/database';
import {
  resolveKnowledgeContext,
  knowledgeError,
  parseEntryText,
} from '@/lib/knowledge-api/context';

const QUESTION_MAX = 2000;

export async function POST(request: Request) {
  const resolved = await resolveKnowledgeContext(request);
  if ('response' in resolved) return resolved.response;
  const { supabase, organizationId, requestId } = resolved.context;

  try {
    const body = (await request.json().catch(() => null)) as
      | { question?: unknown }
      | null;
    if (!body) {
      return knowledgeError(400, 'VALIDATION_ERROR', 'A JSON body is required');
    }
    const question = parseEntryText(body.question, QUESTION_MAX);
    if ('error' in question) {
      return knowledgeError(400, 'VALIDATION_ERROR', `question ${question.error}`);
    }

    const { data, error } = await supabase
      .from('knowledge_entries')
      .select('question, answer')
      .eq('organization_id', organizationId)
      .eq('enabled', true)
      .limit(200);

    if (error) {
      defaultLogger.warn('Knowledge preview read failed', {
        requestId,
        organizationId,
        sqlstateCode: error.code,
      });
      return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    const selected = selectKnowledgeEntries(data ?? [], question.text);
    return NextResponse.json({ selected });
  } catch (err) {
    defaultLogger.error('Knowledge preview failed', err as Error, { requestId });
    return knowledgeError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
