/**
 * Platform capabilities as Workspace chat tools (ADR-022 D6/D7).
 *
 * The customer MCP toolset (./connect.ts) is connection-shaped: every
 * tool hangs off a connected_accounts row and the Connect runtime. A
 * platform capability has NO connection — it is TuGPT's own capability,
 * entitled per organization (B6) and executed by the media pipeline
 * (B7), never by the chat process. This module therefore builds a
 * sibling ChatToolset with the same shape and unions it with the
 * Connect toolset in the messages route.
 *
 * Offering rule (fail-closed): the tool exists only when
 * listEntitledCapabilities says the organization is entitled RIGHT NOW
 * (feature flag on, capability binding enabled, endpoint's approved
 * snapshot contains the bound tool). Any error while checking means NO
 * tool — the turn proceeds without it, exactly like the knowledge
 * degradation in the route.
 *
 * Executing the tool SUBMITS a media job (idempotent per tool call);
 * generation itself happens in the media pipeline, whose executor
 * re-resolves the platform endpoint per job and audits before the
 * billable provider call (media-bridge). The model is told the job is
 * queued and where the result will appear. No provider name, endpoint
 * or platform internal ever reaches the model or the user here: the
 * spec, label and describe output come from TuGPT's own capability
 * definition (B6), never from the provider.
 */
import { listEntitledCapabilities, type EntitledCapability } from '@/lib/platform/capabilities';
import { createPlatformRepository } from '@/lib/platform/platform-repo';
import { createMediaJobsPort } from '@/lib/platform/media-jobs-port';
import { MediaBridgeError, submitPlatformVideoRequest, VIDEO_CAPABILITY_KEY } from '@/lib/platform/media-bridge';
import { createSsoControlClient } from '@/lib/supabase/server';
import type { ChatToolset } from './connect';
import type { ParsedToolCall } from './openai-compatible';

const PLATFORM_PROVIDER_NAME = 'TuGPT';

export interface PlatformSubmitPort {
  submit(input: { prompt: string; aspectRatio?: string; idempotencyKey: string }): Promise<{ jobId: string; alreadyExists: boolean }>;
}

interface TurnScope { organizationId: string; userId: string; threadId: string }

export function buildPlatformToolset(scope: TurnScope, entitled: EntitledCapability, port: PlatformSubmitPort): ChatToolset {
  const properties = (entitled.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  const maxPrompt = typeof properties.prompt?.maxLength === 'number' ? (properties.prompt.maxLength as number) : 1000;
  const ratios = Array.isArray(properties.aspectRatio?.enum) ? (properties.aspectRatio.enum as unknown[]).map(String) : ['16:9', '9:16'];
  const toolName = entitled.toolName;
  return {
    specs: [{ name: toolName, description: entitled.description, parameters: entitled.parameters }],
    labels: [`${PLATFORM_PROVIDER_NAME}: ${entitled.displayName}`],
    describe: (name) => (name === toolName
      ? { capabilityKey: entitled.capabilityKey, providerName: PLATFORM_PROVIDER_NAME, providerKey: 'platform' }
      : null),
    // Submission is the organization's own entitled capability — the same
    // action the media UI offers without an approval card. The billable
    // provider call stays behind the executor's fail-closed audit.
    approvalTarget: () => null,
    async execute(call: ParsedToolCall) {
      if (call.name !== toolName) return { ok: false, code: 'UNKNOWN_TOOL', content: '{"error":"UNKNOWN_TOOL"}' };
      const prompt = typeof call.arguments.prompt === 'string' ? call.arguments.prompt.trim() : '';
      if (!prompt || prompt.length > maxPrompt) {
        return { ok: false, code: 'INVALID_ARGUMENTS', content: JSON.stringify({ error: 'INVALID_ARGUMENTS', detail: `prompt must be 1-${maxPrompt} characters` }) };
      }
      const aspect = call.arguments.aspectRatio;
      if (aspect !== undefined && (typeof aspect !== 'string' || !ratios.includes(aspect))) {
        return { ok: false, code: 'INVALID_ARGUMENTS', content: JSON.stringify({ error: 'INVALID_ARGUMENTS', detail: `aspectRatio must be one of ${ratios.join(', ')}` }) };
      }
      try {
        const { jobId, alreadyExists } = await port.submit({
          prompt,
          ...(typeof aspect === 'string' ? { aspectRatio: aspect } : {}),
          idempotencyKey: `chat:${scope.threadId}:${call.id}`,
        });
        return {
          ok: true,
          content: JSON.stringify({
            jobId, status: 'queued', alreadyExists,
            note: 'The video is being generated. It will appear in the media library when ready; tell the user it has been queued.',
          }),
        };
      } catch (e) {
        if (e instanceof MediaBridgeError) return { ok: false, code: e.code, content: JSON.stringify({ error: e.code }) };
        return { ok: false, code: 'UNAVAILABLE', content: '{"error":"UNAVAILABLE"}' };
      }
    },
  };
}

/** Union of two toolsets; the primary wins name conflicts. */
export function unionToolsets(primary: ChatToolset, extra: ChatToolset): ChatToolset {
  const primaryNames = new Set(primary.specs.map((s) => s.name));
  const extraSpecs = extra.specs.filter((s) => !primaryNames.has(s.name));
  const extraNames = new Set(extraSpecs.map((s) => s.name));
  return {
    specs: [...primary.specs, ...extraSpecs],
    labels: [...primary.labels, ...extra.labels],
    describe: (name) => (extraNames.has(name) ? extra.describe(name) : primary.describe(name)),
    approvalTarget: (name) => (extraNames.has(name) ? extra.approvalTarget(name) : primary.approvalTarget(name)),
    execute: (call) => (extraNames.has(call.name) ? extra.execute(call) : primary.execute(call)),
  };
}

/**
 * The platform toolset for one turn, or null when the organization is
 * not entitled (or entitlement cannot be verified). Uses the trusted
 * sso-control client: entitlement reads service-side platform state and
 * enqueue_media_job membership-checks the user inside the database.
 */
export async function platformToolsetForTurn(scope: TurnScope): Promise<ChatToolset | null> {
  const db = await createSsoControlClient();
  const repo = createPlatformRepository(db);
  const entitled = await listEntitledCapabilities(db, repo, scope.organizationId);
  const video = entitled.find((c) => c.capabilityKey === VIDEO_CAPABILITY_KEY);
  if (!video) return null;
  const jobs = createMediaJobsPort(db);
  return buildPlatformToolset(scope, video, {
    submit: (input) => submitPlatformVideoRequest({ repo, jobs }, {
      organizationId: scope.organizationId, userId: scope.userId,
      prompt: input.prompt, aspectRatio: input.aspectRatio, idempotencyKey: input.idempotencyKey,
    }),
  });
}
