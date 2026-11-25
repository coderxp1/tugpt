/** Per-caller capability matrix. Deny by default. There is deliberately no export/decrypt-raw operation. */
import type { Caller } from './signing.js';

export const OPERATIONS = ['store_oauth_result', 'connection_status', 'get_access_token', 'revoke', 'store_static_secret', 'get_static_secret'] as const;
export type Operation = (typeof OPERATIONS)[number];

const MATRIX: Readonly<Record<Caller, ReadonlySet<Operation>>> = {
  // The public web app can persist the result of an OAuth callback and show status, never obtain tokens.
  // It may also WRITE a customer MCP static secret (admin form), never read one back.
  web: new Set<Operation>(['store_oauth_result', 'connection_status', 'revoke', 'store_static_secret']),
  // Workers execute tools and need short-lived access tokens.
  worker: new Set<Operation>(['get_access_token', 'revoke', 'get_static_secret']),
  // Server-side chat tool execution (docs/connect/finding-chat-broker-caller.md, option A): its own
  // key, read-only. It can obtain a credential for one call; it can never write, revoke or list.
  executor: new Set<Operation>(['get_access_token', 'get_static_secret']),
  // Platform services (ADR-022 D2): operate ONLY platform connections, and
  // only through the /v1/platform/* routes — the server enforces the route
  // separation on top of this matrix, so this caller can never reach an
  // org-scoped credential and no org caller can reach a platform one.
  platform: new Set<Operation>(['store_oauth_result', 'connection_status', 'get_access_token', 'revoke']),
};

export function isAllowed(caller: Caller, op: Operation): boolean {
  return MATRIX[caller]?.has(op) ?? false;
}
