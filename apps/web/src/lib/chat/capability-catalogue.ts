/** Customer-facing capability catalogue (CONF-1). Built only from publicModels(); never from routing data. */
import { configuredModels, publicModels, type ChatModel } from './models';

export const CAPABILITY_CONTRACT = 'chat-model-capabilities/1';

export interface CapabilityEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly available: boolean;
  readonly reasonCode: null | 'TEMPORARILY_UNAVAILABLE' | 'NOT_PERMITTED';
  readonly features: { readonly toolCalling: boolean };
}

export function capabilityCatalogue(models: readonly ChatModel[] = configuredModels()) {
  const pub = publicModels(models);
  const capabilities: CapabilityEntry[] = pub.map((m) => ({
    id: m.capabilityId, label: m.label, description: m.description, available: m.available,
    reasonCode: null, features: { toolCalling: m.toolCalling },
  }));
  return { contract: CAPABILITY_CONTRACT, capabilities, defaultCapabilityId: capabilities[0]?.id ?? null };
}
