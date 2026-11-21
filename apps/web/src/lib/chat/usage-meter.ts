/**
 * USAGE-1: one provider_usage_events row per actual model call of a Workspace
 * chat/agent turn, through Agent 6's recordChatUsage (lib/usage/chat-usage.ts,
 * public.record_chat_usage, migration 20261121700002).
 *
 * Identity of a call: `chat:<turnId>:<callIndex>` (unique per organization in the DB).
 *   callIndex = ATTEMPT_SLOT * attempt + n, where
 *     attempt = assistant answers already stored for this turn before this run
 *               (every attempt stores exactly one, including failed/timed-out/stopped ones),
 *     n       = 0-based model call within this run (tool rounds, then the answer).
 *   A retry therefore gets fresh indices (no under-count), and recording the same
 *   call twice is a DB duplicate (no double count). Concurrent retries of one turn
 *   are already refused by the Q-13 run lease (409) before any model call.
 * Outcome: 'succeeded' when the call returned; 'cancelled' when the caller went away;
 * 'failed' for errors and TIMEOUT-1 timeouts. Usage comes from the provider's own
 * `usage` object only; without one the row is recorded as unavailable (NULL tokens,
 * NULL cost), never as zero.
 * Recording never throws and never delays the answer: calls are recorded when they
 * end, and flush() is awaited only after the answer was persisted and sent.
 * Provider and model are passed for the backend-only columns; nothing here reaches
 * a customer response or a log line.
 */
import { parseOpenAiUsage, recordChatUsage, type UsageLogger, type UsageRpcClient } from '@/lib/usage/chat-usage';

/** Model calls one run may make (2 tool rounds + 1 answer today) fit in one slot; 8 attempts fit in 0..63. */
export const ATTEMPT_SLOT = 8;
export const MAX_CALL_INDEX = 63;

export interface UsageMeterScope {
  readonly control: UsageRpcClient;
  readonly organizationId: string;
  readonly userId: string;
  readonly threadId: string;
  /** null: a turn-less send (database before Q-12); nothing can be keyed, nothing is recorded. */
  readonly turnId: string | null;
  /** Prior attempts of this turn; null when unknown (nothing is recorded rather than risking a collision). */
  readonly attempt: number | null;
  readonly feature: 'chat' | 'agents';
  readonly provider: string;
  readonly model: string | null;
  readonly signal?: AbortSignal;
  readonly logger?: UsageLogger;
}

type Outcome = 'succeeded' | 'failed' | 'cancelled';

export interface UsageMeter {
  /** Wraps one streaming call. `open` receives the onUsage sink to pass as CallOptions.onUsage. */
  stream(open: (onUsage: (u: unknown) => void) => AsyncIterable<string>): AsyncIterable<string>;
  /** Wraps one non-streaming call. */
  call<T>(run: (onUsage: (u: unknown) => void) => Promise<T>): Promise<T>;
  /** Awaits every pending record (call after the answer is stored). Never rejects. */
  flush(): Promise<void>;
  /** Calls started in this run. */
  readonly calls: number;
}

const defaultLogger: UsageLogger = {
  warn(message, meta) { console.warn(JSON.stringify({ event: 'chat.usage.not_recorded', message, ...meta })); },
};

export function createUsageMeter(scope: UsageMeterScope): UsageMeter {
  let n = 0;
  const pending: Promise<unknown>[] = [];
  const logger = scope.logger ?? defaultLogger;

  function begin(): number | null {
    const i = n++;
    if (!scope.turnId || scope.attempt === null || !Number.isInteger(scope.attempt) || scope.attempt < 0) return null;
    const index = scope.attempt * ATTEMPT_SLOT + i;
    if (i >= ATTEMPT_SLOT || index > MAX_CALL_INDEX) {
      logger.warn('Chat usage not recorded: call index out of range', { reason: 'index_out_of_range' });
      return null;
    }
    return index;
  }

  function outcomeOf(e: unknown): Outcome {
    if (scope.signal?.aborted || (e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    return 'failed';
  }

  function record(index: number | null, outcome: Outcome, raw: unknown): void {
    if (index === null || !scope.turnId) return;
    pending.push(recordChatUsage(scope.control, {
      organizationId: scope.organizationId, userId: scope.userId, threadId: scope.threadId, turnId: scope.turnId,
      callIndex: index, feature: scope.feature, provider: scope.provider, model: scope.model, outcome,
      usage: parseOpenAiUsage(raw),
    }, logger).catch(() => 'failed'));
  }

  return {
    get calls() { return n; },
    stream(open) {
      const index = begin();
      return (async function* metered() {
        let raw: unknown = null;
        let outcome: Outcome = 'succeeded';
        try {
          for await (const d of open((u) => { raw = u; })) yield d;
        } catch (e) {
          outcome = outcomeOf(e);
          throw e;
        } finally {
          // A consumer that stops early (turn boundary) still got an answer: 'succeeded'.
          record(index, outcome, raw);
        }
      })();
    },
    async call(run) {
      const index = begin();
      let raw: unknown = null;
      try {
        const out = await run((u) => { raw = u; });
        record(index, 'succeeded', raw);
        return out;
      } catch (e) {
        record(index, outcomeOf(e), raw);
        throw e;
      }
    },
    async flush() { await Promise.allSettled(pending); },
  };
}
