/**
 * The chat capability catalogue, resolved from server configuration only.
 *
 * A capability appears only when its endpoint is actually configured, so the
 * picker never offers something that will fail on send.
 *
 * CONF-1 (provider confidentiality). Two kinds of identifier exist:
 *   - capabilityId: opaque, provider-neutral, the ONLY id a customer ever sees
 *     (API JSON, RSC payloads, page data). e.g. "assistant".
 *   - key (storage/routing key): server-internal. It is what chat_threads.model_key
 *     and custom_agents.model_key hold (unchanged, so a rollback to an older build
 *     still routes existing rows). Never returned to a browser.
 * Endpoints, keys, upstream model names, provider names and infrastructure words
 * never leave the server. Map every stored value through publicCapabilityId() at
 * the response boundary; accept both ids on input (resolveCapability/findModel).
 */
import { LANGDOCK_ALLOWED_MODELS } from '@tugpt/ai-providers';

export type ChatModelProvider = 'private-gpu' | 'langdock';

export interface ChatModel {
  /** Server-internal storage/routing key. Never sent to a browser. */
  readonly key: string;
  /** Opaque customer-facing id. */
  readonly capabilityId: string;
  readonly label: string;
  readonly description: string;
  readonly provider: ChatModelProvider;
  readonly upstreamModel: string;
  /**
   * True only when an operator listed this model key in
   * TUGPT_CHAT_VERIFIED_TOOL_MODELS after it passed the staging tool-calling
   * probe (docs: model-tool-calling.md, `recommendedVerifiedModels`).
   * Default: no model is verified, so no integration tools are exposed.
   */
  readonly toolCalling: boolean;
  /** Prompts stay on TuGPT-operated infrastructure. */
  readonly private: boolean;
}

export interface ModelEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string | null;
}

/**
 * Browser shape. `key` carries the capabilityId (not the storage key) so existing
 * clients that read `key` keep working; `capabilityId` is the field to migrate to.
 */
export interface PublicChatModel {
  readonly key: string;
  readonly capabilityId: string;
  readonly label: string;
  readonly description: string;
  readonly private: boolean;
  readonly toolCalling: boolean;
  readonly available: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Storage key of the private route (legacy value kept in existing rows; server-only). */
export const PRIVATE_MODEL_KEY = 'tugpt-scout';
/** Customer-facing id of the private route. */
export const ASSISTANT_CAPABILITY_ID = 'assistant';
export const ASSISTANT_LABEL = 'TuGPT Assistant';
const HOSTED_PREFIX = 'langdock:';

/** FNV-1a 32-bit, hex. Stable opaque suffix; not a security boundary (the mapping is server-side). */
function opaque(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** http is accepted only on loopback (the private tunnel); anything else must be https. */
export function parseEndpointUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const okProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!okProtocol) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Comma-separated model keys (storage keys or capability ids) that passed tool-calling verification. Empty by default. */
export function verifiedToolModels(env: Env = process.env): ReadonlySet<string> {
  return new Set((env.TUGPT_CHAT_VERIFIED_TOOL_MODELS ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean));
}

export function configuredModels(env: Env = process.env): ChatModel[] {
  const models: ChatModel[] = [];
  const verified = verifiedToolModels(env);
  if (parseEndpointUrl(env.TUGPT_PRIVATE_LLM_URL)) {
    models.push({
      key: PRIVATE_MODEL_KEY,
      capabilityId: ASSISTANT_CAPABILITY_ID,
      label: ASSISTANT_LABEL,
      description: 'Private assistant hosted by TuGPT in the EU. Your prompts stay on TuGPT-operated systems.',
      provider: 'private-gpu',
      upstreamModel: env.TUGPT_PRIVATE_LLM_MODEL || `${PRIVATE_MODEL_KEY}:latest`,
      toolCalling: verified.has(PRIVATE_MODEL_KEY) || verified.has(ASSISTANT_CAPABILITY_ID),
      private: true,
    });
  }
  if (env.LANGDOCK_API_KEY) {
    LANGDOCK_ALLOWED_MODELS.forEach((m, i) => {
      const key = `${HOSTED_PREFIX}${m}`.toLowerCase();
      const capabilityId = hostedCapabilityId(key);
      models.push({
        key,
        capabilityId,
        // Neutral until ROUTE-1 defines approved customer tiers; no vendor or model name.
        label: `${ASSISTANT_LABEL} (hosted option ${i + 1})`,
        description: 'Hosted assistant in the EU.',
        provider: 'langdock',
        upstreamModel: m,
        toolCalling: verified.has(key) || verified.has(capabilityId),
        private: false,
      });
    });
  }
  return models;
}

function hostedCapabilityId(storageKey: string): string {
  return `hosted-${opaque(storageKey.toLowerCase())}`;
}

/**
 * The customer-facing id for any stored or requested value. Never returns the
 * input unless it already is a capability id. Unknown values (a route that was
 * removed) become an opaque `retired-*` id, which resolves to nothing.
 */
export function publicCapabilityId(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  const v = String(stored);
  if (v === ASSISTANT_CAPABILITY_ID || v === PRIVATE_MODEL_KEY) return ASSISTANT_CAPABILITY_ID;
  if (/^(hosted|retired)-[0-9a-f]{8}$/.test(v)) return v;
  if (v.toLowerCase().startsWith(HOSTED_PREFIX)) return hostedCapabilityId(v);
  return `retired-${opaque(v)}`;
}

export function publicModels(models: readonly ChatModel[]): PublicChatModel[] {
  return models.map((m) => ({
    key: m.capabilityId, capabilityId: m.capabilityId, label: m.label, description: m.description,
    private: m.private, toolCalling: m.toolCalling, available: true,
  }));
}

export function endpointFor(model: ChatModel, env: Env = process.env): ModelEndpoint | null {
  if (model.provider === 'private-gpu') {
    const baseUrl = parseEndpointUrl(env.TUGPT_PRIVATE_LLM_URL);
    return baseUrl ? { baseUrl, apiKey: env.TUGPT_PRIVATE_LLM_KEY || null } : null;
  }
  const key = env.LANGDOCK_API_KEY;
  if (!key) return null;
  const baseUrl = parseEndpointUrl(env.LANGDOCK_OPENAI_URL || 'https://api.langdock.com/openai/eu/v1');
  return baseUrl ? { baseUrl, apiKey: key } : null;
}

/** Request fields that may carry the chosen capability (CONF-1). `modelKey` is the deprecated alias. */
export const CAPABILITY_FIELDS = ['capabilityId', 'modelKey'] as const;

/**
 * The capability a request asks for: `capabilityId`, else the `modelKey` alias.
 * Both present with different values is ambiguous and yields '' (resolves to no model -> 400).
 */
export function requestedCapability(body: Readonly<Record<string, unknown>>): unknown {
  const { capabilityId: c, modelKey: k } = body;
  if (c !== undefined && k !== undefined && c !== k) return '';
  return c !== undefined ? c : k;
}

/**
 * Resolves a capability id (current clients) or a legacy storage key (old
 * clients, stored rows; accepted during the transition) to a configured route.
 */
export function findModel(models: readonly ChatModel[], key: unknown): ChatModel | null {
  if (typeof key !== 'string' || key === '') return null;
  return models.find((m) => m.capabilityId === key) ?? models.find((m) => m.key === key) ?? null;
}
