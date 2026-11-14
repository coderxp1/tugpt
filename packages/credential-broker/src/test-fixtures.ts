import { randomBytes } from 'node:crypto';
import type { KeyRing } from './crypto-v2.js';
export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const CONN_A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
export const CONN_A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
export const CONN_B1 = 'bbbbbbbb-0000-4000-8000-000000000001';
/** Throwaway keys generated per test run. Never real key material. */
export function testRing(): KeyRing {
  return new Map([
    ['org.v1', randomBytes(32)],
    ['org.v2', randomBytes(32)],
  ]);
}
