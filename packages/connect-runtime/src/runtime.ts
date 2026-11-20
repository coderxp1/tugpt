/**
 * ConnectToolRuntime — executes model-proposed tool calls safely.
 *
 * Check order (each step fails closed, cheapest/most-specific first, and no
 * credential is fetched until every authorization check has passed):
 *
 *   1. tool is in THIS runtime's registry           → UNKNOWN_TOOL
 *      (the admin MCP bridge is never registered here — ADR-020 A1.3)
 *   2. connection exists in the caller's org        → CONNECTION_NOT_FOUND
 *   3. connection provider matches the tool         → PROVIDER_MISMATCH
 *   4. org policy enables the capability            → POLICY_DISABLED
 *   5. personal connection used only by its owner   → NOT_GRANTED
 *   6. explicit grant for actor/agent + capability  → NOT_GRANTED
 *   7. connection status is connected               → REAUTHORIZATION_REQUIRED / CONNECTION_NOT_ACTIVE
 *   8. connection holds an accepted scope           → SCOPE_MISSING
 *   9. write tools need an approval hook            → APPROVAL_REQUIRED
 *  10. arguments validate                           → INVALID_ARGUMENTS
 *  11. broker issues a token                        → REAUTHORIZATION_REQUIRED / PROVIDER_UNAVAILABLE
 *  12. handler runs; output size-capped             → OUTPUT_TOO_LARGE
 *
 * Every call, allowed or refused, produces exactly one audit event. The
 * runtime never throws to the model loop; it returns a tool message.
 */
import { createHash } from 'node:crypto';
import type { ProposedToolCall, ToolDefinition, ToolLoopMessage } from '@tugpt/ai-providers';
import type {
  AccessTokenSource,
  ApprovalChecker,
  ConnectionDirectory,
  ConnectTool,
  GrantChecker,
  IntegrationPolicy,
  ToolAuditSink,
  ToolErrorCode,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolOutput,
} from './types.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
export const DEFAULT_MAX_CALLS_PER_TURN = 8;

/** Static, model-safe explanations. Provider details never reach the model. */
const MESSAGES: Readonly<Record<ToolErrorCode, string>> = {
  UNKNOWN_TOOL: 'This tool is not available.',
  POLICY_DISABLED: 'Your organization has not enabled this capability.',
  CONNECTION_NOT_FOUND: 'The selected connection was not found.',
  PROVIDER_MISMATCH: 'The selected connection cannot be used with this tool.',
  CONNECTION_NOT_ACTIVE: 'The selected connection is not active.',
  REAUTHORIZATION_REQUIRED: 'The connection needs to be re-authorized by the user.',
  SCOPE_MISSING: 'The connection lacks the permission this tool needs; reconnect with the required access.',
  NOT_GRANTED: 'You or this agent are not permitted to use this connection for this tool.',
  APPROVAL_REQUIRED: 'This action needs explicit user approval.',
  INVALID_ARGUMENTS: 'The tool arguments were invalid.',
  PROVIDER_UNAVAILABLE: 'The external service is unavailable. Try again later.',
  OUTPUT_TOO_LARGE: 'The result was too large; narrow the request.',
  CALL_BUDGET_EXCEEDED: 'Too many tool calls in one turn.',
  INTERNAL: 'The tool failed unexpectedly.',
};

export interface ConnectToolRuntimeOptions {
  readonly tools: readonly ConnectTool<never>[];
  readonly connections: ConnectionDirectory;
  readonly policy: IntegrationPolicy;
  readonly grants: GrantChecker;
  readonly tokens: AccessTokenSource;
  readonly audit: ToolAuditSink;
  readonly approvals?: ApprovalChecker;
  readonly now?: () => number;
  readonly maxOutputBytes?: number;
  readonly maxCallsPerTurn?: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export class ConnectToolRuntime {
  private readonly byModelName: ReadonlyMap<string, ConnectTool<unknown>>;
  private readonly opts: ConnectToolRuntimeOptions;
  private readonly now: () => number;
  private readonly maxOutputBytes: number;
  private readonly maxCallsPerTurn: number;

  constructor(opts: ConnectToolRuntimeOptions) {
    const map = new Map<string, ConnectTool<unknown>>();
    for (const t of opts.tools as readonly ConnectTool<unknown>[]) {
      if (map.has(t.modelName)) throw new Error(`duplicate tool modelName: ${t.modelName}`);
      map.set(t.modelName, t);
    }
    this.byModelName = map;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.maxCallsPerTurn = opts.maxCallsPerTurn ?? DEFAULT_MAX_CALLS_PER_TURN;
  }

  /** Definitions to offer the model — only registered tools, nothing else. */
  modelToolDefinitions(): ToolDefinition[] {
    return [...this.byModelName.values()].map((t) => ({
      name: t.modelName,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Execute a turn's calls SERIALLY (Langdock cannot disable parallel calls). */
  async executeTurn(ctx: ToolExecutionContext, calls: readonly ProposedToolCall[]): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const [i, call] of calls.entries()) {
      if (i >= this.maxCallsPerTurn) {
        results.push(await this.refuse(ctx, call, this.byModelName.get(call.name)?.capability ?? null, 'CALL_BUDGET_EXCEEDED', this.now()));
        continue;
      }
      results.push(await this.executeCall(ctx, call));
    }
    return results;
  }

  /** Calls started through executeBudgetedCall on this instance (one instance = one turn). */
  private budgetedCallsUsed = 0;

  /**
   * Execute ONE call against this instance's per-turn budget (maxCallsPerTurn), for callers that run
   * calls one at a time (the chat turn loop) rather than as one executeTurn batch. Budget-exceeding
   * calls are refused with CALL_BUDGET_EXCEEDED (audited) and never reach the tool. A runtime instance
   * is one turn: construct a new one per request. executeCall stays unbudgeted for single-shot callers.
   */
  async executeBudgetedCall(ctx: ToolExecutionContext, call: ProposedToolCall): Promise<ToolExecutionResult> {
    this.budgetedCallsUsed += 1;
    if (this.budgetedCallsUsed > this.maxCallsPerTurn) {
      return this.refuse(ctx, call, this.byModelName.get(call.name)?.capability ?? null, 'CALL_BUDGET_EXCEEDED', this.now());
    }
    return this.executeCall(ctx, call);
  }

  static toToolMessages(results: readonly ToolExecutionResult[]): ToolLoopMessage[] {
    return results.map((r) => ({ role: 'tool', toolCallId: r.toolCallId, content: r.content }));
  }

  async executeCall(ctx: ToolExecutionContext, call: ProposedToolCall): Promise<ToolExecutionResult> {
    const started = this.now();
    const tool = this.byModelName.get(call.name);
    if (!tool) return this.refuse(ctx, call, null, 'UNKNOWN_TOOL', started);
    try {
      const argumentsSha256 = createHash('sha256').update(canonicalJson(call.arguments)).digest('hex');
      const refusal = await this.authorize(ctx, tool, argumentsSha256);
      if (refusal) return this.refuse(ctx, call, tool.capability, refusal, started);

      const validated = tool.validate(call.arguments, this.now());
      if (!validated.ok) return this.refuse(ctx, call, tool.capability, 'INVALID_ARGUMENTS', started);

      const token = await this.opts.tokens.getAccessToken({ organizationId: ctx.organizationId, connectionId: ctx.connectionId });
      if (!token.ok) {
        const code: ToolErrorCode =
          token.code === 'NOT_CONNECTED' || token.code === 'REQUIRES_AUTHORIZATION' || token.code === 'REFRESH_FAILED'
            ? 'REAUTHORIZATION_REQUIRED'
            : token.code === 'NOT_FOUND'
              ? 'CONNECTION_NOT_FOUND'
              : 'PROVIDER_UNAVAILABLE';
        return this.refuse(ctx, call, tool.capability, code, started);
      }

      const output: ToolOutput = await tool.execute(validated.value, { accessToken: token.value.accessToken, now: this.now });
      if (!output.ok) return this.refuse(ctx, call, tool.capability, output.code, started);

      const content = JSON.stringify({ ok: true, data: output.data });
      if (Buffer.byteLength(content, 'utf8') > this.maxOutputBytes) {
        return this.refuse(ctx, call, tool.capability, 'OUTPUT_TOO_LARGE', started);
      }
      await this.audit(ctx, call, tool.capability, 'ok', started);
      return { toolCallId: call.id, capability: tool.capability, ok: true, content };
    } catch {
      return this.refuse(ctx, call, tool.capability, 'INTERNAL', started);
    }
  }

  private async authorize(ctx: ToolExecutionContext, tool: ConnectTool<unknown>, argumentsSha256: string): Promise<ToolErrorCode | null> {
    const conn = await this.opts.connections.getConnection(ctx.organizationId, ctx.connectionId);
    // Defence in depth: even if a directory implementation ignored the org
    // filter, a foreign-org row is treated as not found.
    if (!conn || conn.organizationId !== ctx.organizationId || conn.id !== ctx.connectionId) return 'CONNECTION_NOT_FOUND';
    if (conn.provider !== tool.provider) return 'PROVIDER_MISMATCH';
    if (!(await this.opts.policy.isCapabilityEnabled(ctx.organizationId, tool.provider, tool.capability))) return 'POLICY_DISABLED';
    if (conn.ownerUserId !== null && conn.ownerUserId !== ctx.actorUserId) return 'NOT_GRANTED';
    const granted = await this.opts.grants.isGranted({
      organizationId: ctx.organizationId,
      connectionId: ctx.connectionId,
      capability: tool.capability,
      actorUserId: ctx.actorUserId,
      agentId: ctx.agentId,
    });
    if (!granted) return 'NOT_GRANTED';
    if (conn.status === 'requires_authorization' || conn.status === 'expired') return 'REAUTHORIZATION_REQUIRED';
    if (conn.status !== 'connected') return 'CONNECTION_NOT_ACTIVE';
    if (tool.acceptedScopes.length > 0 && !tool.acceptedScopes.some((s) => conn.grantedScopes.includes(s))) return 'SCOPE_MISSING';
    // Write tools require the approval flow (not part of this slice).
    if (tool.risk !== 'read') {
      const approved = await (this.opts.approvals?.claimApproval({
        organizationId: ctx.organizationId,
        connectionId: ctx.connectionId,
        capability: tool.capability,
        actorUserId: ctx.actorUserId,
        argumentsSha256,
      }) ?? false);
      if (!approved) return 'APPROVAL_REQUIRED';
    }
    return null;
  }

  private async refuse(
    ctx: ToolExecutionContext,
    call: ProposedToolCall,
    capability: string | null,
    code: ToolErrorCode,
    started: number
  ): Promise<ToolExecutionResult> {
    await this.audit(ctx, call, capability, code, started);
    return {
      toolCallId: call.id,
      capability,
      ok: false,
      code,
      content: JSON.stringify({ ok: false, error: code, message: MESSAGES[code] }),
    };
  }

  private async audit(
    ctx: ToolExecutionContext,
    call: ProposedToolCall,
    capability: string | null,
    outcome: 'ok' | ToolErrorCode,
    started: number
  ): Promise<void> {
    const end = this.now();
    try {
      await this.opts.audit.record({
        at: new Date(end).toISOString(),
        requestId: ctx.requestId,
        organizationId: ctx.organizationId,
        actorUserId: ctx.actorUserId,
        agentId: ctx.agentId,
        connectionId: ctx.connectionId,
        toolCallId: call.id,
        capability,
        outcome,
        durationMs: Math.max(0, end - started),
        argumentsSha256: createHash('sha256').update(canonicalJson(call.arguments)).digest('hex'),
      });
    } catch {
      // Audit-sink failure must not leak into the model loop; the sink
      // implementation is responsible for alerting (see threat model T-AU).
    }
  }
}
