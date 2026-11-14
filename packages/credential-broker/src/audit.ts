/** Append-only access log. Holds no token material, by type: there is no field for it. */
import type { Caller } from './signing.js';
import type { Operation } from './authz.js';

export type AuditOutcome =
  | 'ok'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'not_connected'
  | 'refresh_failed'
  | 'persist_failed'
  | 'bad_request'
  | 'error';

export interface CredentialAuditEvent {
  readonly at: string;
  readonly requestId: string;
  readonly caller: Caller | null;
  readonly operation: Operation | null;
  readonly organizationId: string | null;
  readonly connectionId: string | null;
  readonly outcome: AuditOutcome;
  /** Short machine code, never a vendor message or secret. */
  readonly detail?: string;
}

export interface AuditSink {
  record(event: CredentialAuditEvent): Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: CredentialAuditEvent[] = [];
  async record(event: CredentialAuditEvent): Promise<void> {
    this.events.push(Object.freeze({ ...event }));
  }
}
