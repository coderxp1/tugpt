/**
 * Broker client for the platform namespace (ADR-022 D2): caller 'platform',
 * key from TUGPT_BROKER_PLATFORM_KEY (hex, >= 32 bytes), broker at
 * TUGPT_BROKER_URL. Returns null when unconfigured so routes can fail closed
 * with a typed 503 instead of guessing.
 */
import { BrokerClient } from '@tugpt/credential-broker/dist/client.js';

export function platformBrokerClient(env: NodeJS.ProcessEnv = process.env): BrokerClient | null {
  const baseUrl = env.TUGPT_BROKER_URL;
  const key = env.TUGPT_BROKER_PLATFORM_KEY?.trim();
  if (!baseUrl || !key) return null;
  try {
    return new BrokerClient({ baseUrl, caller: 'platform', key: Buffer.from(key, 'hex') });
  } catch {
    return null;
  }
}
