/**
 * @file prompt-builder.ts
 * @description Builds ChatMessage[] from source message text and ai_draft_config fields.
 *
 * Constructs a system message from business_instructions, personality,
 * response_rules and tone, followed by a guardrail block that no per-organization
 * configuration can remove.
 *
 * maxDraftLength is an output-length constraint measured in characters against
 * the final draft text. It is NOT passed as maxTokens (which is a token limit).
 * A separate conservative provider-token limit may be used by the orchestrator.
 *
 * 2026-08-30 — TWO CHANGES, BOTH FROM THE SUPERVISED FLIP.
 *
 * The evidence from that flip is the reason this file changed rather than only
 * the seeded defaults. Run against the unconstrained configuration, the model
 * invented opening hours and a $300–$800 price range for a bakery that had told
 * it neither. Run against a configuration carrying anti-invention rules, the
 * same questions produced grounded refusals and a request for contact details.
 * The difference was entirely in the config text — which is to say it was
 * optional, editable, and one careless edit away from being gone.
 *
 *   1. The guardrail is emitted here, for every draft, and is appended LAST so
 *      that nothing in the per-organization text sits after it. An organization
 *      can shape its own voice; it cannot switch off the rule that stops the
 *      model inventing prices to a customer.
 *
 *   2. The scaffolding is Spanish. It was English — "Business Instructions:",
 *      "Keep your response under N characters" — wrapped around Spanish
 *      business instructions, which is a mixed-language prompt and a nudge
 *      toward English replies in a product whose customers write Spanish. The
 *      reply language is not decided by this scaffolding either way: the
 *      guardrail states explicitly that the draft follows the language the
 *      customer wrote in, which is what an Ecuadorian shop with the occasional
 *      English-speaking tourist actually needs (ADR-015 records the same point:
 *      the customer's language is not the operator's).
 *
 * 2026-08-31 — the scaffolding follows `organizations.locale`.
 *
 * Hardcoding Spanish was right while one organization existed and it was
 * Spanish. It is the same mixed-language defect mirrored the moment a second
 * one has `locale = 'en'`: English business instructions inside Spanish
 * headings, under a Spanish block of non-negotiable rules. The words now live
 * in `prompt-scaffolding.ts`, keyed by locale, and an unknown locale falls back
 * to Spanish rather than failing a draft. See that file for why the rules are
 * a keyed record rather than a list.
 */

import type { ChatMessage } from '@tugpt/ai-providers';
import type { DraftConfig } from './types';
import {
  GUARDRAIL_RULES,
  MAX_LENGTH_PLACEHOLDER,
  scaffoldingFor,
  type Scaffolding,
} from './prompt-scaffolding';

/**
 * The rules that hold for every organization, in every draft.
 *
 * Deliberately narrow. This is not a place to encode product opinions about
 * how a business should talk to its customers — that is what
 * `ai_draft_configs` is for. Every line here exists because getting it wrong
 * produces a message a business would have to retract:
 *
 *   * inventing a price, an opening hour or an availability is a promise the
 *     business did not make, and the reviewer approving the draft may not know
 *     the number is fabricated;
 *   * a draft that cannot answer is far more useful as a captured lead than as
 *     a plausible guess;
 *   * claiming to be a person when asked directly is a lie the business would
 *     be making, not the model.
 *
 * On that last rule: nothing here tells the model to announce itself
 * unprompted. Every draft is read and approved by a person before it is sent,
 * so the message is the business's own words. But a *mandatory* instruction to
 * conceal how it was written is not something to bake into every organization's
 * prompt, so the rule is honesty when asked rather than disclosure by default.
 *
 * @param maxDraftLength - character ceiling for the finished draft
 */
function guardrails(scaffolding: Scaffolding, maxDraftLength: number): string {
  // Rendered in GUARDRAIL_RULES order, not object order, so the block reads the
  // same in every locale. Object key order would follow whatever order somebody
  // happened to type the translation in.
  const lines = GUARDRAIL_RULES.map((rule) =>
    scaffolding.rules[rule].split(MAX_LENGTH_PLACEHOLDER).join(String(maxDraftLength))
  );
  return [scaffolding.guardrailHeading, ...lines].join('\n');
}

/**
 * Build the chat messages for draft generation.
 *
 * @param sourceText - The inbound message text from the customer
 * @param config - The ai_draft_config fields (business_instructions, personality, response_rules, tone, max_draft_length)
 * @returns ChatMessage[] with a system message and a user message
 */
export function buildPromptMessages(sourceText: string, config: DraftConfig): ChatMessage[] {
  // `locale` is optional so that a caller which has not been taught about it
  // still produces a valid Spanish prompt rather than a broken one. The worker
  // passes it; see `loadDraftConfig`.
  const scaffolding = scaffoldingFor(config.locale ?? '');
  const systemParts: string[] = [];

  if (config.businessInstructions) {
    systemParts.push(`${scaffolding.businessInstructions}\n${config.businessInstructions}`);
  }

  if (config.personality) {
    systemParts.push(`${scaffolding.personality}\n${config.personality}`);
  }

  if (config.responseRules) {
    systemParts.push(`${scaffolding.responseRules}\n${config.responseRules}`);
  }

  if (config.tone) {
    systemParts.push(`${scaffolding.tone}\n${config.tone}`);
  }

  // Knowledge (FAQ v1): the selected entries, rendered as a data
  // block under the framing that subordinates them — facts to use,
  // never instructions to obey. Present only when the caller
  // selected at least one entry for this message; with none, the
  // prompt is exactly what it was before FAQ existed. The block
  // sits BEFORE the guardrails on purpose: the non-negotiable rules
  // remain the last word, so nothing an entry says — mistaken or
  // malicious — can outrank them.
  if (config.knowledgeEntries && config.knowledgeEntries.length > 0) {
    const entries = config.knowledgeEntries
      .map((entry) => `P: ${entry.question}\nR: ${entry.answer}`)
      .join('\n\n');
    systemParts.push(
      `${scaffolding.knowledgeHeading}\n${scaffolding.knowledgeFraming}\n\n${entries}`
    );
  }

  // Last, and unconditional. A config with every field empty still produces a
  // system message with these rules in it — which is the state a newly created
  // organization is in before anyone has written its instructions.
  systemParts.push(guardrails(scaffolding, config.maxDraftLength));

  const systemContent = systemParts.join('\n\n');

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: sourceText },
  ];
}
