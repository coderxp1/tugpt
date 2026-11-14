/**
 * The chat model catalogue, resolved from server configuration only.
 *
 * A model appears only when its endpoint is actually configured, so the
 * picker never offers something that will fail on send. Endpoints and keys
 * never leave the server: the browser sees {key,label,description,private}.
 */
import { LANGDOCK_ALLOWED_MODELS } from '@tugpt/ai-providers';

export type ChatModelProvider = 'private-gpu' | 'langdock';

export interface ChatModel {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly provider: ChatModelProvider;
  readonly upstreamModel: string;
  /** True only where tool calling has live evidence (private GPU: Nov 14 probe). */
  readonly toolCalling: boolean;
  /** Prompts stay on TuGPT-operated infrastructure. */
  readonly private: boolean;
}

export interface ModelEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string | null;
}

export type PublicChatModel = Pick<ChatModel, 'key' | 'label' | 'description' | 'private' | 'toolCalling'>;

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const PRIVATE_MODEL_KEY = 'tugpt-scout';

/** http is accepted only on loopback (the GPU tunnel); anything else must be https. */
export function parseEndpointUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const okProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!okProtocol) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function configuredModels(env: Env = process.env): ChatModel[] {
  const models: ChatModel[] = [];
  if (parseEndpointUrl(env.TUGPT_PRIVATE_LLM_URL)) {
    models.push({
      key: PRIVATE_MODEL_KEY,
      label: 'TuGPT Scout',
      description: 'Private model on TuGPT\u2019s EU GPU. Prompts stay on TuGPT infrastructure.',
      provider: 'private-gpu',
      upstreamModel: env.TUGPT_PRIVATE_LLM_MODEL || 'tugpt-scout:latest',
      toolCalling: true,
      private: true,
    });
  }
  if (env.LANGDOCK_API_KEY) {
    for (const m of LANGDOCK_ALLOWED_MODELS) {
      models.push({
        key: `langdock:${m}`.toLowerCase(),
        label: m,
        description: 'Hosted model through Langdock (EU).',
        provider: 'langdock',
        upstreamModel: m,
        toolCalling: false,
        private: false,
      });
    }
  }
  return models;
}

export function publicModels(models: readonly ChatModel[]): PublicChatModel[] {
  return models.map(({ key, label, description, private: p, toolCalling }) => ({ key, label, description, private: p, toolCalling }));
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

export function findModel(models: readonly ChatModel[], key: unknown): ChatModel | null {
  return typeof key === 'string' ? models.find((m) => m.key === key) ?? null : null;
}
