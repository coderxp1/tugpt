/**
 * @file types.ts
 * @description Type definitions for the draft generation orchestration layer.
 *
 * These types wrap the structured ProviderError from @tugpt/ai-providers
 * and define the request/result contracts for draft generation.
 * No circular dependency: ai-orchestration imports from ai-providers,
 * never the reverse.
 */

import type { ProviderError } from '@tugpt/ai-providers';

/** Re-export for convenience */
export type { ProviderErrorCategory, ProviderError } from '@tugpt/ai-providers';

/** Whether a provider error is eligible for fallback to the secondary provider. */
export type FallbackDecision = 'FALLBACK_ALLOWED' | 'FALLBACK_PROHIBITED';

/** Configuration fields from ai_draft_configs, used to build the prompt. */
export interface DraftConfig {
  readonly businessInstructions: string;
  readonly personality: string;
  readonly responseRules: string;
  readonly tone: string;
  readonly maxDraftLength: number;
  /**
   * The owning organization's `organizations.locale`, which decides the
   * language of the prompt scaffolding and the non-negotiable rules.
   *
   * Typed `string`, not a union, on purpose: this package would otherwise have
   * to depend on `@tugpt/database` for `OrganizationLocale`, and the value
   * arriving here has already crossed a database boundary, so a union would be
   * a claim rather than a guarantee. `scaffoldingFor` coerces anything it
   * cannot render to Spanish, and `apps/worker/tests` asserts that the set it
   * can render is exactly `ORGANIZATION_LOCALES`.
   *
   * Optional so that a caller written before 2026-08-31 still produces a valid
   * Spanish prompt rather than failing to compile in a hurry.
   */
  readonly locale?: string;
  /**
   * Knowledge entries (FAQ v1) already selected for this message by
   * the caller — the worker's deterministic keyword selection over
   * the organization's enabled entries. Optional and usually absent:
   * with no entries the built prompt is byte-identical to the
   * pre-FAQ prompt, which is the missing-answer path (the guardrails
   * then govern: do not invent, capture the lead).
   *
   * Entry text is UNTRUSTED business content. The prompt builder
   * renders it inside the subordinated data block (see
   * prompt-scaffolding's knowledge framing), never as instructions,
   * and the guardrail block still follows it.
   */
  readonly knowledgeEntries?: readonly KnowledgeEntry[];
}

/** One FAQ/knowledge pair, as stored in public.knowledge_entries. */
export interface KnowledgeEntry {
  readonly question: string;
  readonly answer: string;
}

/** Request for draft generation. */
export interface DraftRequest {
  readonly sourceMessageText: string;
  readonly config: DraftConfig;
  readonly organizationId: string;
  readonly requestId: string;
}

/** Successful draft generation result. */
export interface DraftResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  /**
   * The provider's own identifier for the call.
   *
   * Carried so a recorded cost can be matched back to an invoice line. Without
   * it, a disputed charge has nothing on our side to reconcile against.
   */
  readonly providerReference: string;
  /**
   * Tokens consumed, straight from the provider's response.
   *
   * Every adapter has computed this since the contract was written
   * (`adapter.ts:41-45`); until migration 20260903000002 nothing persisted it,
   * so it was measured on every draft and discarded. It is on `DraftResult`
   * rather than logged in the orchestrator because the worker is what knows
   * the organization the cost belongs to.
   */
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

/** Orchestrator return type: success or structured error. */
export type DraftGenerationResult =
  | { success: true; result: DraftResult }
  | { success: false; error: ProviderError };