/**
 * Chat/agent usage recording (dashboard M2, migration 20261121700002).
 *
 * The chat route (Agent 4) calls `recordChatUsage` once per model call of a
 * turn, on the same sso_control client it already uses for
 * `append_chat_turn_message_server`. The database binds the call to the thread's
 * organization and owner (P3U02 otherwise) and dedupes on
 * (organization, turn, callIndex) — a retried request with the same turn id and
 * call index is acknowledged as `duplicate` and never double-counted.
 *
 * Usage basis, in order of preference:
 *   reported    — the provider returned usage (`stream_options.include_usage`).
 *   estimated   — TuGPT computed token counts itself; pass `estimate`.
 *   unavailable — neither; the call is still counted (requests, outcome), with
 *                 no tokens and no cost. Unknown is never recorded as zero.
 *
 * Recording must never break or delay a chat answer: this function never
 * throws, and it logs only codes — never prompts, answers, provider or model
 * strings, or keys.
 */

export interface UsageRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    readonly data: unknown;
    readonly error: {
      readonly code?: string;
      readonly message?: string;
    } | null;
  }>;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ChatUsageInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly turnId: string;
  /** 0-based index of the model call within the turn (tool loops make several). 0..63. */
  readonly callIndex: number;
  readonly feature?: "chat" | "agents";
  /** Internal provider key (backend-only; never shown to customers). */
  readonly provider: string;
  /** Internal model id (backend-only; never shown to customers). */
  readonly model: string | null;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  /** Provider-reported usage, e.g. from parseOpenAiUsage. */
  readonly usage?: TokenUsage | null;
  /** TuGPT's own estimate, used only when no reported usage exists. */
  readonly estimate?: TokenUsage | null;
  readonly requestId?: string | null;
}

export type RecordResult = "recorded" | "duplicate" | "skipped" | "failed";

export interface UsageLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const MAX_TOKENS = 10_000_000;

function tokenCount(v: unknown): number | null {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= MAX_TOKENS
    ? v
    : null;
}

/**
 * Read an OpenAI-compatible `usage` object (chat.completions: prompt_tokens /
 * completion_tokens; responses API: input_tokens / output_tokens). Returns null
 * unless both counts are present and sane — a partial or garbage object is
 * "unavailable", not a guess.
 */
export function parseOpenAiUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = tokenCount(u.prompt_tokens ?? u.input_tokens);
  const output = tokenCount(u.completion_tokens ?? u.output_tokens);
  if (input === null || output === null) return null;
  return { inputTokens: input, outputTokens: output };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validTokens(t: TokenUsage | null | undefined): TokenUsage | null {
  if (!t) return null;
  const i = tokenCount(t.inputTokens);
  const o = tokenCount(t.outputTokens);
  return i === null || o === null ? null : { inputTokens: i, outputTokens: o };
}

export async function recordChatUsage(
  control: UsageRpcClient,
  input: ChatUsageInput,
  logger?: UsageLogger,
): Promise<RecordResult> {
  const provider =
    typeof input.provider === "string"
      ? input.provider.trim().toLowerCase()
      : "";
  if (
    !UUID.test(input.organizationId) ||
    !UUID.test(input.userId) ||
    !UUID.test(input.threadId) ||
    !UUID.test(input.turnId) ||
    !Number.isInteger(input.callIndex) ||
    input.callIndex < 0 ||
    input.callIndex > 63 ||
    !PROVIDER.test(provider)
  ) {
    logger?.warn("Chat usage not recorded: invalid reference", {
      reason: "invalid_input",
    });
    return "skipped";
  }

  const reported = validTokens(input.usage);
  const estimated = reported ? null : validTokens(input.estimate);
  const tokens = reported ?? estimated;
  const basis = reported ? "reported" : estimated ? "estimated" : "unavailable";
  const model =
    typeof input.model === "string" && input.model.length > 0
      ? input.model.slice(0, 200)
      : null;

  try {
    const { data, error } = await control.rpc("record_chat_usage", {
      p_organization_id: input.organizationId,
      p_user_id: input.userId,
      p_thread_id: input.threadId,
      p_turn_id: input.turnId,
      p_call_index: input.callIndex,
      p_feature: input.feature ?? "chat",
      p_provider: provider,
      p_model: model,
      p_input_tokens: tokens ? tokens.inputTokens : null,
      p_output_tokens: tokens ? tokens.outputTokens : null,
      p_usage_basis: basis,
      p_outcome: input.outcome,
      p_request_id: input.requestId
        ? String(input.requestId).slice(0, 200)
        : null,
    });
    if (error) {
      logger?.warn("Chat usage not recorded", {
        reason: "rpc_error",
        sqlstateCode: error.code ?? null,
      });
      return "failed";
    }
    const duplicate = !!(
      data &&
      typeof data === "object" &&
      (data as { duplicate?: unknown }).duplicate === true
    );
    return duplicate ? "duplicate" : "recorded";
  } catch {
    logger?.warn("Chat usage not recorded", { reason: "exception" });
    return "failed";
  }
}
