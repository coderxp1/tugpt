import { describe, expect, it, vi } from "vitest";
import {
  parseOpenAiUsage,
  recordChatUsage,
  type ChatUsageInput,
  type UsageRpcClient,
} from "./chat-usage";

const BASE: ChatUsageInput = {
  organizationId: "a6000000-0000-4000-8000-00000000000a",
  userId: "a6000000-0000-4000-8000-0000000000a5",
  threadId: "a6700000-0000-4000-8000-0000000000a5",
  turnId: "a6799999-0000-4000-8000-000000000001",
  callIndex: 0,
  provider: "OpenAI",
  model: "internal-model-x",
  outcome: "succeeded",
};

function client(
  result:
    | { data?: unknown; error?: { code?: string; message?: string } | null }
    | Error,
) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve({
          data: result.data ?? null,
          error: result.error ?? null,
        }),
  );
  return { rpc } as unknown as UsageRpcClient & { rpc: typeof rpc };
}

describe("parseOpenAiUsage", () => {
  it("reads chat.completions usage", () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 3 });
  });
  it("reads responses-API usage", () => {
    expect(parseOpenAiUsage({ input_tokens: 7, output_tokens: 0 })).toEqual({
      inputTokens: 7,
      outputTokens: 0,
    });
  });
  it("treats partial, negative, fractional or absurd counts as unavailable", () => {
    expect(parseOpenAiUsage(null)).toBeNull();
    expect(parseOpenAiUsage({ prompt_tokens: 5 })).toBeNull();
    expect(
      parseOpenAiUsage({ prompt_tokens: -1, completion_tokens: 2 }),
    ).toBeNull();
    expect(
      parseOpenAiUsage({ prompt_tokens: 1.5, completion_tokens: 2 }),
    ).toBeNull();
    expect(
      parseOpenAiUsage({ prompt_tokens: "5", completion_tokens: 2 }),
    ).toBeNull();
    expect(
      parseOpenAiUsage({ prompt_tokens: 1e9, completion_tokens: 2 }),
    ).toBeNull();
  });
});

describe("recordChatUsage", () => {
  it("records reported usage with a normalised provider key", async () => {
    const c = client({ data: { event_id: "e1", duplicate: false } });
    const r = await recordChatUsage(c, {
      ...BASE,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(r).toBe("recorded");
    const [fn, args] = c.rpc.mock.calls[0];
    expect(fn).toBe("record_chat_usage");
    expect(args).toMatchObject({
      p_provider: "openai",
      p_feature: "chat",
      p_usage_basis: "reported",
      p_input_tokens: 100,
      p_output_tokens: 20,
      p_outcome: "succeeded",
      p_call_index: 0,
    });
  });

  it("prefers reported over estimated, and uses the estimate only when nothing was reported", async () => {
    const c1 = client({ data: { duplicate: false } });
    await recordChatUsage(c1, {
      ...BASE,
      usage: { inputTokens: 1, outputTokens: 1 },
      estimate: { inputTokens: 9, outputTokens: 9 },
    });
    expect(c1.rpc.mock.calls[0][1]).toMatchObject({
      p_usage_basis: "reported",
      p_input_tokens: 1,
    });
    const c2 = client({ data: { duplicate: false } });
    await recordChatUsage(c2, {
      ...BASE,
      usage: null,
      estimate: { inputTokens: 9, outputTokens: 4 },
    });
    expect(c2.rpc.mock.calls[0][1]).toMatchObject({
      p_usage_basis: "estimated",
      p_input_tokens: 9,
      p_output_tokens: 4,
    });
  });

  it("records a failed call with no usage as unavailable with NULL quantities (never zero)", async () => {
    const c = client({ data: { duplicate: false } });
    await recordChatUsage(c, { ...BASE, outcome: "failed" });
    expect(c.rpc.mock.calls[0][1]).toMatchObject({
      p_usage_basis: "unavailable",
      p_input_tokens: null,
      p_output_tokens: null,
      p_outcome: "failed",
    });
  });

  it("reports a retry as duplicate", async () => {
    const c = client({ data: { event_id: "e1", duplicate: true } });
    expect(
      await recordChatUsage(c, {
        ...BASE,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toBe("duplicate");
  });

  it("skips invalid references without calling the database", async () => {
    const c = client({ data: {} });
    expect(await recordChatUsage(c, { ...BASE, turnId: "not-a-uuid" })).toBe(
      "skipped",
    );
    expect(await recordChatUsage(c, { ...BASE, callIndex: 64 })).toBe(
      "skipped",
    );
    expect(await recordChatUsage(c, { ...BASE, provider: "Open AI" })).toBe(
      "skipped",
    );
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("never throws, and logs only codes — no provider, model or token data", async () => {
    const logger = { warn: vi.fn() };
    const failing = client({
      error: { code: "P3U02", message: "Usage target not found" },
    });
    expect(
      await recordChatUsage(
        failing,
        { ...BASE, usage: { inputTokens: 5, outputTokens: 5 } },
        logger,
      ),
    ).toBe("failed");
    const throwing = client(new Error("connection reset"));
    expect(await recordChatUsage(throwing, BASE, logger)).toBe("failed");
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain("P3U02");
    expect(logged).not.toMatch(
      /openai|internal-model-x|connection reset|Usage target/i,
    );
  });
});
