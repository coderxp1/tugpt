/**
 * Attach a customer-supplied static credential to an MCP endpoint
 * (ADR-021 R1/R2, Plan A1).
 *
 * Orchestration: begin (DB creates the mcp_custom account and links it to the
 * endpoint) -> broker store (web caller, the only place the secret goes) ->
 * complete (account becomes `connected`). Any failure after begin runs the
 * fail compensation, so an endpoint never sits half-attached: either it has a
 * connected broker-held credential or it has none.
 *
 * The secret is passed to the broker exactly once. It is never logged, never
 * returned, and never written to the database by this module.
 */

import { BrokerClient } from '@tugpt/credential-broker/dist/client.js';
import {
  AuthAlreadyAttachedError,
  type ExternalMcpRepository,
} from './external-mcp-repo';

/** The one broker operation this flow needs (BrokerClient satisfies it). */
export interface StaticSecretStore {
  storeStaticSecret(
    scope: { organizationId: string; connectionId: string },
    secret: string,
  ): Promise<
    | { ok: true; value: { credentialVersion: number } }
    | { ok: false; code: string }
  >;
}

const HEX_KEY = /^(?:[0-9a-f]{2}){32,}$/i;

/**
 * Web-caller broker client for credential writes (TUGPT_BROKER_URL +
 * TUGPT_BROKER_CALLER_KEY, hex, >= 32 bytes — same convention as the Google /
 * Microsoft routes). Null when unconfigured or malformed: callers must fail
 * closed rather than register an endpoint whose credential cannot be stored.
 */
export function webBrokerClient(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrokerClient | null {
  const baseUrl = env.TUGPT_BROKER_URL;
  const key = env.TUGPT_BROKER_CALLER_KEY?.trim();
  if (!baseUrl || !key || !HEX_KEY.test(key)) return null;
  try {
    return new BrokerClient({ baseUrl, caller: 'web', key: Buffer.from(key, 'hex') });
  } catch {
    return null;
  }
}

export type AttachStaticCredentialResult =
  | { readonly ok: true; readonly connectionId: string }
  | {
      readonly ok: false;
      readonly stage: 'begin' | 'store' | 'complete';
      readonly code: string;
    };

export async function attachStaticCredential(deps: {
  readonly repo: ExternalMcpRepository;
  readonly broker: StaticSecretStore;
  readonly organizationId: string;
  readonly endpointId: string;
  readonly secret: string;
}): Promise<AttachStaticCredentialResult> {
  const { repo, broker, organizationId, endpointId, secret } = deps;

  let connectionId: string;
  try {
    connectionId = await repo.beginStaticCredential(organizationId, endpointId);
  } catch (err) {
    if (err instanceof AuthAlreadyAttachedError) {
      return { ok: false, stage: 'begin', code: 'AUTH_ALREADY_ATTACHED' };
    }
    throw err;
  }

  const stored = await broker.storeStaticSecret({ organizationId, connectionId }, secret);
  if (!stored.ok) {
    await repo.failStaticCredential(organizationId, endpointId, connectionId).catch(() => false);
    return { ok: false, stage: 'store', code: stored.code };
  }

  const completed = await repo.completeStaticCredential(organizationId, connectionId);
  if (!completed) {
    await repo.failStaticCredential(organizationId, endpointId, connectionId).catch(() => false);
    return { ok: false, stage: 'complete', code: 'COMPLETE_FAILED' };
  }

  return { ok: true, connectionId };
}
