/**
 * CONF-1: no internal model id, host, port or hardware wording in anything the
 * customer API returns. RESTRICTED mirrors Agent 5's release scanner
 * (a5-staging/e2e/leakscan.cjs); keep the two in step.
 */
import { describe, expect, it } from 'vitest';
import { LANGDOCK_ALLOWED_MODELS } from '@tugpt/ai-providers';
import { configuredModels, findModel, publicCapabilityId, publicModels } from './models';
import { capabilityCatalogue } from './capability-catalogue';
import { toConversation } from '@/lib/workspace-data/conversations';
import { toAgent } from '@/lib/workspace-data/agents';
import { publicImage } from '@/lib/create/request';
import { RESTRICTED } from './conf1.test-harness';


const ENV = {
  TUGPT_PRIVATE_LLM_URL: 'http://127.0.0.1:12435/v1', TUGPT_PRIVATE_LLM_MODEL: 'llama4-scout:latest',
  TUGPT_PRIVATE_LLM_KEY: 'k-private', LANGDOCK_API_KEY: 'k-langdock', TUGPT_CHAT_VERIFIED_TOOL_MODELS: 'tugpt-scout',
};
const clean = (v: unknown) => {
  const json = JSON.stringify(v);
  expect(json).not.toMatch(RESTRICTED);
  for (const m of LANGDOCK_ALLOWED_MODELS) expect(json).not.toContain(m);
  expect(json).not.toContain('k-private');
  expect(json).not.toContain('k-langdock');
  expect(json).not.toMatch(/langdock|private-gpu|upstream/i);
};

describe('CONF-1 customer surfaces carry opaque capability ids only', () => {
  const models = configuredModels(ENV);

  it('the restricted pattern really catches the internal identifiers', () => {
    for (const s of ['tugpt-scout', 'TuGPT Scout', 'EU GPU', 'llama4-scout:latest', 'http://127.0.0.1:12435/v1']) expect(s).toMatch(RESTRICTED);
  });

  it('public model list and capability catalogue', () => {
    const pub = publicModels(models);
    expect(pub[0]).toMatchObject({ key: 'assistant', capabilityId: 'assistant', label: 'TuGPT Assistant', private: true, toolCalling: true });
    for (const m of pub.slice(1)) expect(m.capabilityId).toMatch(/^hosted-[0-9a-f]{8}$/);
    expect(new Set(pub.map((m) => m.capabilityId)).size).toBe(pub.length);
    clean(pub);
    const cat = capabilityCatalogue(models);
    expect(cat).toMatchObject({ contract: 'chat-model-capabilities/1', defaultCapabilityId: 'assistant' });
    expect(cat.capabilities.every((c) => c.available && c.reasonCode === null)).toBe(true);
    clean(cat);
  });

  it('ids are stable across processes and input accepts the id or the legacy key', () => {
    expect(publicModels(configuredModels(ENV))).toEqual(publicModels(models));
    for (const m of models) {
      const id = publicCapabilityId(m.key)!;
      expect(findModel(models, id)).toBe(m);
      expect(findModel(models, m.key)).toBe(m);
    }
    expect(publicCapabilityId(null)).toBeNull();
    expect(publicCapabilityId('some-removed-model')).toMatch(/^retired-[0-9a-f]{8}$/);
  });

  it('thread, agent and image mappers', () => {
    const t = toConversation({ id: 't', title: 'x', model_key: 'tugpt-scout', folder_id: null, archived_at: null, created_at: 'c', updated_at: 'u' });
    expect(t).toMatchObject({ modelKey: 'assistant', capabilityId: 'assistant' });
    clean(t);
    for (const m of models.slice(1)) clean(toConversation({ id: 't', title: 'x', model_key: m.key, created_at: 'c', updated_at: 'u' }));
    const a = toAgent({
      id: 'a', name: 'n', description: null, instructions: 'i', model_key: 'tugpt-scout', conversation_starters: [],
      visibility: 'private', owner_user_id: 'u1', created_at: 'c', updated_at: 'u', version: 1, tools: [],
    }, 'u1', 'member', []);
    expect(a).toMatchObject({ modelKey: 'assistant', capabilityId: 'assistant' });
    clean(a);
    const img = publicImage({ id: 'i', prompt: 'p', width: 1, height: 1, seed: 1, modelKey: 'Tongyi-MAI/Z-Image-Turbo', status: 'completed', progress: 100, errorCode: null, seconds: 1, createdAt: 'c', finishedAt: 'f' });
    expect(JSON.stringify(img)).not.toMatch(/Z-Image|modelKey/);
  });
});

describe('CONF-1 request input', () => {
  it('capabilityId wins, modelKey is the alias, and conflicting values are refused', async () => {
    const { requestedCapability } = await import('./models');
    expect(requestedCapability({ capabilityId: 'assistant' })).toBe('assistant');
    expect(requestedCapability({ modelKey: 'tugpt-scout' })).toBe('tugpt-scout');
    expect(requestedCapability({ capabilityId: 'assistant', modelKey: 'assistant' })).toBe('assistant');
    expect(requestedCapability({ capabilityId: 'assistant', modelKey: 'hosted-00000000' })).toBe('');
    expect(requestedCapability({})).toBeUndefined();
  });
});
