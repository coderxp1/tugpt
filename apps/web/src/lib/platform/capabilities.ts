/**
 * Capability-shaped platform surface (Plan B6, ADR-022 D4/D6).
 *
 * Org-facing surfaces see ONLY these TuGPT-authored capability definitions:
 * TuGPT's name, TuGPT's description, TuGPT's parameter schema. The provider
 * identity, endpoint URL, remote tool name and binding config live in the
 * platform registry and never cross into a capability definition — the leak
 * tests assert exactly that. An org gets a capability only when (a) its
 * entitlement flag is on (ADR-015: flags are the operative gate until
 * entitlements are enforced), (b) an operator binding exists and is
 * enabled, and (c) the bound endpoint currently resolves (active +
 * approved snapshot + the bound tool present).
 */
import type { TypedSupabaseClient } from '@tugpt/database';
import type { PlatformRepository } from './platform-repo';
import { resolvePlatformEndpoint, PlatformResolveError } from './platform-resolver';

export interface PlatformCapabilityDefinition {
  key: string;
  /** Model-facing tool name (TuGPT's own). */
  toolName: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Existing feature flag that gates the capability per organization. */
  entitlementFlag: string;
}

export const PLATFORM_CAPABILITY_DEFINITIONS: readonly PlatformCapabilityDefinition[] = [
  {
    key: 'video.generate',
    toolName: 'generate_video',
    displayName: 'Video generation',
    description: 'Create a short AI-generated video from a written prompt. The video is produced asynchronously and appears in the workspace when it is ready.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 1000, description: 'What the video should show, including style and mood.' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Video aspect ratio.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    entitlementFlag: 'media_generation',
  },
];

export interface EntitledCapability {
  capabilityKey: string;
  toolName: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointId: string;
  remoteToolName: string;
}

/** Fail-closed entitlement check via the is_feature_enabled RPC. */
async function flagEnabled(admin: TypedSupabaseClient, organizationId: string, flag: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any).rpc('is_feature_enabled', {
    p_organization_id: organizationId, p_flag_key: flag,
  });
  if (error) return false;
  return data === true;
}

export async function listEntitledCapabilities(
  admin: TypedSupabaseClient,
  repo: PlatformRepository,
  organizationId: string,
): Promise<EntitledCapability[]> {
  const out: EntitledCapability[] = [];
  for (const def of PLATFORM_CAPABILITY_DEFINITIONS) {
    if (!(await flagEnabled(admin, organizationId, def.entitlementFlag))) continue;
    const binding = await repo.getBinding(def.key);
    if (!binding || !binding.enabled) continue;
    try {
      const resolved = await resolvePlatformEndpoint(repo, binding.endpointId);
      if (!resolved.tools.some((t) => t.name === binding.toolName)) continue;
    } catch (e) {
      if (e instanceof PlatformResolveError) continue;
      throw e;
    }
    out.push({
      capabilityKey: def.key, toolName: def.toolName, displayName: def.displayName,
      description: def.description, parameters: def.parameters,
      endpointId: binding.endpointId, remoteToolName: binding.toolName,
    });
  }
  return out;
}
