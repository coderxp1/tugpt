/** Per-caller capability matrix. Deny by default. There is deliberately no export/decrypt-raw operation. */
import type { Caller } from './signing.js';

export const OPERATIONS = ['store_oauth_result', 'connection_status', 'get_access_token', 'revoke'] as const;
export type Operation = (typeof OPERATIONS)[number];

const MATRIX: Readonly<Record<Caller, ReadonlySet<Operation>>> = {
  // The public web app can persist the result of an OAuth callback and show status, never obtain tokens.
  web: new Set<Operation>(['store_oauth_result', 'connection_status', 'revoke']),
  // Workers execute tools and need short-lived access tokens.
  worker: new Set<Operation>(['get_access_token', 'revoke']),
};

export function isAllowed(caller: Caller, op: Operation): boolean {
  return MATRIX[caller]?.has(op) ?? false;
}
