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
 *   Crash edge case: a run that recorded calls but died before storing its answer
 *   leaves `attempt` unchanged, so the next run's first index collides. A meter records
 *   each of its own calls exactly once, so a `duplicate` it receives always belongs to
 *   another (dead) run: the meter moves to the next attempt slot and keeps that shift for
 *   its later calls. Residual: a crash between a model call and its record loses that one
 *   record (under-count, never a double count).
 * Outcome: 'succeeded' when the call returned; 'cancelled' when the caller went away;
 * 'failed' for errors and TIMEOUT-1 timeouts. Usage comes from the provider's own
 * `usage` object only; without one the call is passed as `usage: null` and the event is
 * recorded with usage_basis = 'unavailable' (NULL cost). The event's usage_basis is the
 * authoritative marker. Since migration 20261125000003 (S0.4, gate defect U6),
 * record_chat_usage writes NO token components for 'unavailable' events, so no
 * reader can mistake unknown usage for a provider-reported 0.
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

  // Slots skipped because an earlier (crashed) run already used them; shared by later calls.
  let shift = 0;
  // Records run one after another so a learned shift applies to every later call.
  let chain: Promise<unknown> = Promise.resolve();

  function begin(): number | null {
    const i = n++;
    if (!scope.turnId || scope.attempt === null || !Number.isInteger(scope.attempt) || scope.attempt < 0) return null;
    if (i >= ATTEMPT_SLOT) {
      logger.warn('Chat usage not recorded: call index out of range', { reason: 'index_out_of_range' });
      return null;
    }
    return i;
  }

  async function recordAt(i: number, outcome: Outcome, raw: unknown): Promise<void> {
    const usage = parseOpenAiUsage(raw);
    // S0.4 (gate defect U1): a transient recording failure (RPC/transport error)
    // is retried with the SAME idempotency key, bounded — the old code dropped
    // the event permanently after a single failed attempt. A 'duplicate' that
    // arrives after one of MY attempts failed means that attempt actually
    // landed and only its response was lost: the record exists exactly once,
    // so it must NOT trigger the crash-shift (that would double-count it at
    // the next slot). A 'duplicate' on the first attempt still belongs to an
    // earlier, crashed run and shifts as before.
    let failures = 0;
    for (;;) {
      const index = ((scope.attempt as number) + shift) * ATTEMPT_SLOT + i;
      if (index > MAX_CALL_INDEX) {
        logger.warn('Chat usage not recorded: call index out of range', { reason: 'index_out_of_range' });
        return;
      }
      const result = await recordChatUsage(scope.control, {
        organizationId: scope.organizationId, userId: scope.userId, threadId: scope.threadId, turnId: scope.turnId as string,
        callIndex: index, feature: scope.feature, provider: scope.provider, model: scope.model, outcome, usage,
      }, logger);
      if (result === 'duplicate') {
        if (failures > 0) return;
        shift += 1;
        continue;
      }
      if (result === 'failed') {
        failures += 1;
        if (failures >= 3) {
          logger.warn('Chat usage not recorded: recording failed after retries', { reason: 'recording_failed' });
          return;
        }
        continue;
      }
      return;
    }
  }

  function outcomeOf(e: unknown): Outcome {
    if (scope.signal?.aborted || (e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    return 'failed';
  }

  function record(i: number | null, outcome: Outcome, raw: unknown): void {
    if (i === null || !scope.turnId) return;
    chain = chain.then(() => recordAt(i, outcome, raw)).catch(() => undefined);
    pending.push(chain);
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
