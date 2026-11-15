/**
 * Connect tool runtime — shared types (ADR-021 D1/D2/D4, ADR-020 A1).
 *
 * The runtime is the ONLY component that turns a model's proposed tool call
 * into an external API call. Everything it depends on is an interface so the
 * same runtime serves chat, agents and workflows, and so tests can prove the
 * security ordering without a network.
 */
import type { JsonSchemaObject } from '@tugpt/ai-providers';
import type { AccessTokenGrant, BrokerResult } from '@tugpt/credential-broker';

export type ToolRisk = 'read' | 'write';

/** Mirrors connected_accounts (migration 20261112000001). */
export interface ConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  /** null = org-level connection; otherwise a personal connection (ADR-021 D2). */
  readonly ownerUserId: string | null;
  readonly provider: string;
  readonly status: 'connected' | 'disconnected' | 'expired' | 'requires_authorization' | 'error';
  readonly grantedScopes: readonly string[];
}

export interface ToolExecutionContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  /** Set when an agent/workflow acts; null for direct chat use by the user. */
  readonly agentId: string | null;
  /** Chosen by the user via `@`-mention or by agent configuration — never by the model. */
  readonly connectionId: string;
  readonly requestId: string;
}

/** Must query strictly by (organization_id, id). */
export interface ConnectionDirectory {
  getConnection(organizationId: string, connectionId: string): Promise<ConnectionRecord | null>;
}

/** organization_integration_policies: is this capability enabled for the org? */
export interface IntegrationPolicy {
  isCapabilityEnabled(organizationId: string, provider: string, capability: string): Promise<boolean>;
}

/** connection_grants: may this actor/agent use this capability on this connection? */
export interface GrantChecker {
  isGranted(input: {
    organizationId: string;
    connectionId: string;
    capability: string;
    actorUserId: string;
    agentId: string | null;
  }): Promise<boolean>;
}

/** Per-call approval for write/irreversible/financial tools (B-7). */
export interface ApprovalChecker {
  claimApproval(input: {
    organizationId: string;
    connectionId: string;
    capability: string;
    actorUserId: string;
    argumentsSha256: string;
  }): Promise<boolean>;
}

/** Satisfied by `BrokerClient` (caller = worker). */
export interface AccessTokenSource {
  getAccessToken(scope: { organizationId: string; connectionId: string }): Promise<BrokerResult<AccessTokenGrant>>;
}

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'POLICY_DISABLED'
  | 'CONNECTION_NOT_FOUND'
  | 'PROVIDER_MISMATCH'
  | 'CONNECTION_NOT_ACTIVE'
  | 'REAUTHORIZATION_REQUIRED'
  | 'SCOPE_MISSING'
  | 'NOT_GRANTED'
  | 'APPROVAL_REQUIRED'
  | 'INVALID_ARGUMENTS'
  | 'PROVIDER_UNAVAILABLE'
  | 'OUTPUT_TOO_LARGE'
  | 'CALL_BUDGET_EXCEEDED'
  | 'INTERNAL';

export type ToolOutput =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: ToolErrorCode };

export type ValidationOutcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly detail: string };

export interface ToolHandlerDeps {
  readonly accessToken: string;
  readonly now: () => number;
}

export interface ConnectTool<A = unknown> {
  /** Registry capability key, e.g. 'calendar.find_availability'. */
  readonly capability: string;
  /** Model-facing function name (^[a-zA-Z0-9_-]{1,64}$). */
  readonly modelName: string;
  readonly provider: string;
  readonly risk: ToolRisk;
  /** Connection must hold at least one of these scopes. */
  readonly acceptedScopes: readonly string[];
  readonly description: string;
  readonly parameters: JsonSchemaObject;
  validate(raw: Readonly<Record<string, unknown>>, now: number): ValidationOutcome<A>;
  execute(args: A, deps: ToolHandlerDeps): Promise<ToolOutput>;
}

export interface ToolAuditEvent {
  readonly at: string;
  readonly requestId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly agentId: string | null;
  readonly connectionId: string;
  readonly toolCallId: string;
  /** null when the model named an unknown tool. */
  readonly capability: string | null;
  readonly outcome: 'ok' | ToolErrorCode;
  readonly durationMs: number;
  /** SHA-256 of canonical argument JSON — never the raw arguments. */
  readonly argumentsSha256: string;
}

export interface ToolAuditSink {
  record(event: ToolAuditEvent): Promise<void>;
}

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly capability: string | null;
  readonly ok: boolean;
  readonly code?: ToolErrorCode;
  /** JSON string handed back to the model as the tool message. Size-capped. */
  readonly content: string;
}
